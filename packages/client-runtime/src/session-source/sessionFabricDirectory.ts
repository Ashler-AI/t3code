import {
  EnvironmentId,
  SessionFabricClientId,
  SessionFabricContextBundle,
  SessionFabricContextRequest,
  SessionFabricDirectoryResponse,
  SessionFabricSearchRequest,
  SessionFabricSearchResponse,
  SessionFabricSessionId,
  type SessionFabricContextBundle as SessionFabricContextBundleType,
  type SessionFabricContextRequest as SessionFabricContextRequestType,
  type SessionFabricDirectoryResponse as SessionFabricDirectoryResponseType,
  type SessionFabricSearchRequest as SessionFabricSearchRequestType,
  type SessionFabricSearchResponse as SessionFabricSearchResponseType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SessionFabricConnectionRegistration } from "../connection/catalog.ts";
import { SessionFabricConnectionTarget } from "../connection/model.ts";
import {
  type SessionFabricAuthorizationShape,
  sessionFabricAuthorizationHeaders,
} from "./sessionFabricAuthorization.ts";

export class SessionFabricDirectoryClientError extends Schema.TaggedErrorClass<SessionFabricDirectoryClientError>()(
  "SessionFabricDirectoryClientError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}

export interface SessionFabricDirectoryClientOptions {
  readonly relayBaseUrl: string | URL;
  readonly authorization: SessionFabricAuthorizationShape;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SessionFabricDirectoryClient {
  readonly list: () => Effect.Effect<
    SessionFabricDirectoryResponseType,
    SessionFabricDirectoryClientError
  >;
  readonly search: (
    request: SessionFabricSearchRequestType,
  ) => Effect.Effect<SessionFabricSearchResponseType, SessionFabricDirectoryClientError>;
  readonly context: (
    request: SessionFabricContextRequestType,
  ) => Effect.Effect<SessionFabricContextBundleType, SessionFabricDirectoryClientError>;
}

const decodeDirectory = Schema.decodeUnknownEffect(SessionFabricDirectoryResponse);
const decodeSearch = Schema.decodeUnknownEffect(SessionFabricSearchResponse);
const decodeContext = Schema.decodeUnknownEffect(SessionFabricContextBundle);
const isDirectoryClientError = Schema.is(SessionFabricDirectoryClientError);
const encodeSearch = Schema.encodeSync(Schema.fromJsonString(SessionFabricSearchRequest));
const encodeContext = Schema.encodeSync(Schema.fromJsonString(SessionFabricContextRequest));

function fabricApiUrl(relayBaseUrl: string | URL, resource: "sessions" | "search" | "context") {
  const url = new URL(relayBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/${resource}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function makeSessionFabricDirectoryClient(
  options: SessionFabricDirectoryClientOptions,
): SessionFabricDirectoryClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);

  const request = <A>(input: {
    readonly operation: string;
    readonly resource: "sessions" | "search" | "context";
    readonly init?: RequestInit;
    readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
  }): Effect.Effect<A, SessionFabricDirectoryClientError> =>
    Effect.tryPromise({
      try: async () => {
        const send = async (forceRefresh: boolean): Promise<Response> => {
          const grant = await Effect.runPromise(options.authorization.viewer({ forceRefresh }));
          const response = await fetchImplementation(
            fabricApiUrl(options.relayBaseUrl, input.resource),
            {
              ...input.init,
              headers: {
                ...Object.fromEntries(new Headers(input.init?.headers).entries()),
                ...sessionFabricAuthorizationHeaders(grant),
              },
            },
          );
          if (
            response.status === 401 &&
            !forceRefresh &&
            options.authorization.mode === "capability"
          ) {
            options.authorization.invalidate("viewer");
            return send(true);
          }
          return response;
        };
        const response = await send(false);
        if (!response.ok) throw new Error(`request failed with status ${response.status}`);
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new SessionFabricDirectoryClientError({
          operation: input.operation,
          detail: cause instanceof Error ? cause.message : "Session fabric request failed.",
        }),
    }).pipe(
      Effect.flatMap(input.decode),
      Effect.mapError((cause) =>
        isDirectoryClientError(cause)
          ? cause
          : new SessionFabricDirectoryClientError({
              operation: input.operation,
              detail: "Session fabric returned an invalid response.",
            }),
      ),
    );

  return {
    list: () =>
      request({
        operation: "sessionFabric.directory.list",
        resource: "sessions",
        decode: decodeDirectory,
      }),
    search: (search) =>
      request({
        operation: "sessionFabric.directory.search",
        resource: "search",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeSearch(search),
        },
        decode: decodeSearch,
      }),
    context: (context) =>
      request({
        operation: "sessionFabric.directory.context",
        resource: "context",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeContext(context),
        },
        decode: decodeContext,
      }),
  };
}

export function sessionFabricConnectionForContext(input: {
  readonly relayBaseUrl: string | URL;
  readonly context: SessionFabricContextBundleType;
  readonly clientId: string;
}): SessionFabricConnectionRegistration | null {
  const continuationRef = input.context.continuationRef;
  if (continuationRef === null || !continuationRef.startsWith("session-fabric:")) return null;
  const referencedId = continuationRef.slice("session-fabric:".length);
  if (referencedId !== input.context.session.sessionId) return null;
  const sessionId = SessionFabricSessionId.make(referencedId);
  return new SessionFabricConnectionRegistration({
    target: new SessionFabricConnectionTarget({
      environmentId: EnvironmentId.make(`session-fabric:${sessionId}`),
      label: input.context.session.title,
      relayBaseUrl: new URL(input.relayBaseUrl).toString(),
      sessionId,
      clientId: SessionFabricClientId.make(input.clientId),
    }),
  });
}
