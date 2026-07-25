import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";

describe("fetchEnvironmentShellSnapshot", () => {
  it.effect("adds the ephemeral Scaffold attach grant to snapshot HTTP requests", () =>
    Effect.gen(function* () {
      let receivedGrant: string | null = null;
      let receivedCredentials: RequestCredentials | undefined;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Scaffold environment",
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      });
      const prepared: PreparedConnection = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
        httpAuthorization: null,
        scaffoldAttachCredential: "attach-secret",
        target,
      };
      const fetchFn = ((input, init) => {
        receivedGrant = new Request(input, init).headers.get("x-scaffold-attach-grant");
        receivedCredentials = init?.credentials;
        return Promise.resolve(Response.json({}));
      }) satisfies typeof fetch;

      yield* Effect.result(
        fetchEnvironmentShellSnapshot({ prepared, signer: Option.none() }).pipe(
          Effect.provide(remoteHttpClientLayer(fetchFn)),
        ),
      );

      expect(receivedGrant).toBe("attach-secret");
      expect(receivedCredentials).toBe("include");
    }),
  );
});
