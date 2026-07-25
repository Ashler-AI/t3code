import type {
  OmpAccountAssignment,
  OmpAccountCapabilities,
  OmpAccountRef,
  OmpAccountOverview,
  OmpAccountsSnapshot,
  OmpLoginChallenge,
  OmpUsageSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

import {
  parseOmpAccountAssignment,
  parseOmpAccountsList,
  parseOmpLoginChallenge,
  parseOmpUsageResponse,
} from "./OmpAccountParsers.ts";

export const OMP_ACCOUNT_METHODS = {
  list: "_omp/accounts/list",
  login: "_omp/accounts/login",
  loginRespond: "_omp/accounts/login/respond",
  loginCancel: "_omp/accounts/login/cancel",
  remove: "_omp/accounts/remove",
  assignment: "_omp/accounts/assignment",
  usage: "_omp/usage",
} as const;

type OmpAccountOperation = keyof typeof OMP_ACCOUNT_METHODS;
type OmpAccountCapability = keyof OmpAccountCapabilities;

export class OmpAccountServiceError extends Schema.TaggedErrorClass<OmpAccountServiceError>()(
  "OmpAccountServiceError",
  {
    reason: Schema.Literals([
      "unavailable",
      "invalid-response",
      "managed-by-broker",
      "request-failed",
    ]),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Sanitized transport failure; callers must not place protocol payloads or credentials in detail. */
export class OmpAccountTransportError extends Schema.TaggedErrorClass<OmpAccountTransportError>()(
  "OmpAccountTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface OmpAccountExtensionTransport {
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, OmpAccountTransportError>;
}

export interface OmpAccountServiceOptions extends OmpAccountExtensionTransport {
  readonly mode?: "local" | "broker";
  readonly isMethodNotFound?: (cause: unknown) => boolean;
}

export interface OmpAccountServiceShape {
  readonly getSnapshot: Effect.Effect<OmpAccountOverview>;
  readonly listAccounts: Effect.Effect<OmpAccountsSnapshot>;
  readonly getUsage: (options?: { readonly refresh?: boolean }) => Effect.Effect<OmpUsageSnapshot>;
  readonly beginLogin: (
    provider: string,
  ) => Effect.Effect<OmpLoginChallenge, OmpAccountServiceError>;
  readonly respondLogin: (
    provider: string,
    flowId: string,
    response: string,
  ) => Effect.Effect<OmpLoginChallenge, OmpAccountServiceError>;
  readonly cancelLogin: (flowId: string) => Effect.Effect<void, OmpAccountServiceError>;
  readonly removeAccount: (
    accountRef: OmpAccountRef,
  ) => Effect.Effect<void, OmpAccountServiceError>;
  readonly getAssignmentForSession: (
    nativeSessionId: string,
    threadId: ThreadId,
  ) => Effect.Effect<OmpAccountAssignment, OmpAccountServiceError>;
}

export class OmpAccountService extends Context.Service<OmpAccountService, OmpAccountServiceShape>()(
  "t3/ompAccounts/OmpAccountService",
) {}

function assignmentUnavailable(detail: string) {
  return new OmpAccountServiceError({
    reason: "unavailable",
    operation: "assignment",
    detail,
  });
}

function readOmpNativeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor !== "object" || resumeCursor === null || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const cursor = resumeCursor as Record<string, unknown>;
  if (cursor.schemaVersion !== 1 && cursor.schemaVersion !== 2 && cursor.schemaVersion !== 3) {
    return undefined;
  }
  if (typeof cursor.sessionId !== "string" || cursor.sessionId.trim().length === 0) {
    return undefined;
  }
  return cursor.sessionId.trim();
}

/** Resolve a browser-visible T3 thread to its private OMP session server-side. */
export const getOmpThreadAccountAssignment = Effect.fn("getOmpThreadAccountAssignment")(function* (
  providerService: Pick<ProviderServiceShape, "listSessions">,
  accounts: OmpAccountServiceShape,
  threadId: ThreadId,
) {
  // ProviderService overlays active adapter sessions with the authoritative
  // ProviderSessionDirectory binding, including its persisted resume cursor.
  const session = (yield* providerService.listSessions()).find(
    (candidate) => candidate.threadId === threadId,
  );
  if (!session) {
    return yield* assignmentUnavailable("No active provider session exists for this thread.");
  }

  if (session.provider !== "omp") {
    return yield* assignmentUnavailable("This thread is not backed by OMP.");
  }
  if (session.status === "closed" || session.status === "error") {
    return yield* assignmentUnavailable("This OMP session is not active.");
  }

  const nativeSessionId = readOmpNativeSessionId(session.resumeCursor);
  if (!nativeSessionId) {
    return yield* assignmentUnavailable("This OMP session has not started yet.");
  }
  return yield* accounts.getAssignmentForSession(nativeSessionId, threadId);
});

const ACCOUNT_REFRESH_WARNING =
  "OMP account data could not be refreshed; showing the last cached result.";
const USAGE_REFRESH_WARNING =
  "OMP plan usage could not be refreshed; showing the last cached result.";

function errorText(cause: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (cause instanceof Error) {
    const nested = "cause" in cause ? errorText(cause.cause, depth + 1) : "";
    return `${cause.name} ${cause.message} ${nested}`.trim();
  }
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>;
    return [record._tag, record.code, record.message, record.detail, record.cause]
      .map((entry) => errorText(entry, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  return String(cause ?? "");
}

export function isOmpExtensionMethodNotFound(cause: unknown): boolean {
  const text = errorText(cause).toLowerCase();
  return (
    text.includes("method not found") ||
    text.includes("unknown method") ||
    text.includes("unsupported method") ||
    text.includes("-32601")
  );
}

type ExtensionResult =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failure"; readonly cause: unknown };

function capabilityForOperation(operation: OmpAccountOperation): OmpAccountCapability {
  switch (operation) {
    case "list":
      return "accounts";
    case "login":
    case "loginRespond":
    case "loginCancel":
      return "login";
    case "remove":
      return "remove";
    case "assignment":
      return "assignment";
    case "usage":
      return "usage";
  }
}

export const makeOmpAccountService = Effect.fn("makeOmpAccountService")(function* (
  options: OmpAccountServiceOptions,
) {
  const mode = options.mode ?? "local";
  const managed = mode === "broker";
  const initialCapabilities: OmpAccountCapabilities = {
    accounts: true,
    login: !managed,
    remove: !managed,
    assignment: true,
    usage: true,
  };
  const capabilitiesRef = yield* Ref.make(initialCapabilities);
  const accountsRef = yield* Ref.make<ReadonlyArray<OmpAccountsSnapshot["accounts"][number]>>([]);
  const accountsWarningRef = yield* Ref.make<string | null>(null);
  const usageRef = yield* Ref.make<OmpUsageSnapshot>({
    reports: [],
    refreshedAt: null,
    stale: false,
    warning: null,
  });
  const methodNotFound = options.isMethodNotFound ?? isOmpExtensionMethodNotFound;

  const setCapability = (capability: OmpAccountCapability, supported: boolean) =>
    Ref.update(capabilitiesRef, (current) => ({ ...current, [capability]: supported }));

  const call = Effect.fn("OmpAccountService.call")(function* (
    operation: OmpAccountOperation,
    payload: unknown,
  ): Effect.fn.Return<ExtensionResult> {
    const method = OMP_ACCOUNT_METHODS[operation];
    return yield* options.request(method, payload).pipe(
      Effect.map((value): ExtensionResult => ({ _tag: "Success", value })),
      Effect.catch(
        (cause): Effect.Effect<ExtensionResult> =>
          Effect.succeed(methodNotFound(cause) ? { _tag: "Missing" } : { _tag: "Failure", cause }),
      ),
    );
  });

  const rejectManaged = (operation: OmpAccountOperation) =>
    new OmpAccountServiceError({
      reason: "managed-by-broker",
      operation,
      detail: "This Scaffold environment manages OpenAI and Anthropic accounts centrally.",
    });

  const requestError = (operation: OmpAccountOperation, reason: "unavailable" | "request-failed") =>
    new OmpAccountServiceError({
      reason,
      operation,
      detail:
        reason === "unavailable"
          ? "This OMP runtime does not support the requested account operation."
          : "OMP could not complete the requested account operation.",
    });

  const invalidResponse = (operation: OmpAccountOperation) =>
    new OmpAccountServiceError({
      reason: "invalid-response",
      operation,
      detail: "OMP returned an invalid account response.",
    });

  const listAccounts = Effect.gen(function* () {
    const result = yield* call("list", {});
    let warning: string | null = null;
    if (result._tag === "Success") {
      const accounts = parseOmpAccountsList(result.value, { managed });
      if (accounts) {
        yield* Ref.set(accountsRef, accounts);
        yield* setCapability("accounts", true);
      } else {
        warning = ACCOUNT_REFRESH_WARNING;
      }
    } else {
      warning = ACCOUNT_REFRESH_WARNING;
      if (result._tag === "Missing") yield* setCapability("accounts", false);
    }
    const [accounts, capabilities] = yield* Effect.all([
      Ref.get(accountsRef),
      Ref.get(capabilitiesRef),
    ]);
    yield* Ref.set(accountsWarningRef, warning);
    return { mode, managed, accounts, capabilities, warning } satisfies OmpAccountsSnapshot;
  });

  const getUsage = Effect.fn("OmpAccountService.getUsage")(function* (input?: {
    readonly refresh?: boolean;
  }) {
    const result = yield* call("usage", { refresh: input?.refresh === true });
    if (result._tag === "Success") {
      const usage = parseOmpUsageResponse(result.value);
      if (usage) {
        yield* Ref.set(usageRef, usage);
        yield* setCapability("usage", true);
        return usage;
      }
    } else if (result._tag === "Missing") {
      yield* setCapability("usage", false);
    }
    const cached = yield* Ref.get(usageRef);
    const stale = {
      ...cached,
      stale: true,
      warning: USAGE_REFRESH_WARNING,
    } satisfies OmpUsageSnapshot;
    yield* Ref.set(usageRef, stale);
    return stale;
  });

  const getSnapshot = Effect.gen(function* () {
    const [accounts, capabilities, warning, usage] = yield* Effect.all([
      Ref.get(accountsRef),
      Ref.get(capabilitiesRef),
      Ref.get(accountsWarningRef),
      Ref.get(usageRef),
    ]);
    return {
      accounts: { mode, managed, accounts, capabilities, warning },
      usage,
    } satisfies OmpAccountOverview;
  });

  const requireMutation = Effect.fn("OmpAccountService.requireMutation")(function* (
    operation: "login" | "loginRespond" | "loginCancel" | "remove",
    payload: unknown,
  ) {
    if (managed) return yield* rejectManaged(operation);
    const result = yield* call(operation, payload);
    const capability = capabilityForOperation(operation);
    if (result._tag === "Missing") {
      yield* setCapability(capability, false);
      return yield* requestError(operation, "unavailable");
    }
    if (result._tag === "Failure") return yield* requestError(operation, "request-failed");
    yield* setCapability(capability, true);
    return result.value;
  });

  const beginLogin = Effect.fn("OmpAccountService.beginLogin")(function* (provider: string) {
    const value = yield* requireMutation("login", { provider });
    const challenge = parseOmpLoginChallenge(value, provider);
    if (!challenge) return yield* invalidResponse("login");
    return challenge;
  });

  const respondLogin = Effect.fn("OmpAccountService.respondLogin")(function* (
    provider: string,
    flowId: string,
    response: string,
  ) {
    const value = yield* requireMutation("loginRespond", { flowId, response });
    const challenge = parseOmpLoginChallenge(value, provider);
    if (!challenge) return yield* invalidResponse("loginRespond");
    return challenge;
  });

  const cancelLogin = Effect.fn("OmpAccountService.cancelLogin")(function* (flowId: string) {
    yield* requireMutation("loginCancel", { flowId });
  });

  const removeAccount = Effect.fn("OmpAccountService.removeAccount")(function* (
    accountRef: OmpAccountRef,
  ) {
    yield* requireMutation("remove", { accountRef });
    yield* Ref.update(accountsRef, (accounts) =>
      accounts.filter((account) => account.accountRef !== accountRef),
    );
  });

  const getAssignmentForSession = Effect.fn("OmpAccountService.getAssignmentForSession")(function* (
    nativeSessionId: string,
    threadId: ThreadId,
  ) {
    const result = yield* call("assignment", { sessionId: nativeSessionId });
    if (result._tag === "Missing") {
      yield* setCapability("assignment", false);
      return { threadId, account: null, automatic: true } satisfies OmpAccountAssignment;
    }
    if (result._tag === "Failure") return yield* requestError("assignment", "request-failed");
    const assignment = parseOmpAccountAssignment(result.value, threadId, { managed });
    if (!assignment) return yield* invalidResponse("assignment");
    yield* setCapability("assignment", true);
    return assignment;
  });

  return OmpAccountService.of({
    getSnapshot,
    listAccounts,
    getUsage,
    beginLogin,
    respondLogin,
    cancelLogin,
    removeAccount,
    getAssignmentForSession,
  });
});
