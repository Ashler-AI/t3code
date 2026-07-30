import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  SESSION_FABRIC_CAPABILITY_TYP,
  SessionFabricRunnerId,
  SessionFabricSessionId,
  type SessionFabricCapabilityClaims,
  type SessionFabricSnapshot,
} from "@t3tools/contracts/session-fabric";
import { decodeProtectedHeader } from "jose";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  authorizeSessionFabricCapability,
  bearerCapability,
  capabilityCanListDirectory,
  capabilityCanControlSession,
  capabilityCanReadSession,
  capabilityCanRunSession,
  isPublicLocalLocation,
  isPublicSessionRecord,
  localRunnerCapabilityMatchesAuthority,
  isPublicScaffoldLocation,
  isPublicScaffoldSnapshot,
  isPublicScaffoldViewLocation,
  parseSessionFabricPublicKeys,
  sessionFabricWebSocketProtocols,
  signSessionFabricCapability,
  verifySessionFabricCapability,
  websocketCapability,
} from "./sessionFabricCapability.ts";

const NOW = 1_785_000_000;
const encodeUnknownJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const otherKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});

const base = {
  v: 1,
  iss: "https://scaffold.example",
  aud: "ashler-session-fabric",
  sub: "user-1",
  jti: "cap-1",
  iat: NOW,
  nbf: NOW - 1,
  exp: NOW + 60,
} as const;

const viewer = {
  ...base,
  role: "viewer",
  actorId: "user-1",
  scopes: ["directory:read", "session:read"],
} as const satisfies SessionFabricCapabilityClaims;

const controller = {
  ...base,
  role: "controller",
  actorId: "user-1",
  scopes: ["session:read", "session:command"],
  fabricSessionId: SessionFabricSessionId.make("sf:env:thread"),
  scaffoldSessionId: "ses_1",
  scaffoldLifecycleEpoch: 7,
} as const satisfies SessionFabricCapabilityClaims;

const location = {
  environmentKind: "scaffold",
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  repositoryRoot: "/workspace",
  worktreePath: null,
  scaffoldSessionId: "ses_1",
  scaffoldSessionUrl: "https://scaffold.example/sessions/ses_1",
  scaffoldLifecycleEpoch: 7,
} as const;

const snapshot = {
  session: {
    sessionId: SessionFabricSessionId.make("sf:env:thread"),
    publication: "public" as const,
    location,
  },
} as unknown as SessionFabricSnapshot;

const legacySnapshot = {
  session: {
    ...snapshot.session,
    runnerState: "offline" as const,
    location: {
      ...location,
      scaffoldLifecycleEpoch: undefined,
    },
  },
} as unknown as SessionFabricSnapshot;

const config = {
  mode: "required" as const,
  issuer: base.iss,
  audience: base.aud,
  publicKeys: { current: keys.publicKey, previous: otherKeys.publicKey },
};

describe("session fabric capabilities", () => {
  it.effect("signs and verifies a strict kid-selected Ed25519 capability", () =>
    Effect.gen(function* () {
      const token = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: viewer,
      });
      expect(decodeProtectedHeader(token)).toEqual({
        alg: "EdDSA",
        kid: "current",
        typ: SESSION_FABRIC_CAPABILITY_TYP,
      });
      expect(yield* verifySessionFabricCapability({ config, token, nowEpochSeconds: NOW })).toEqual(
        viewer,
      );
    }),
  );

  it.effect("rejects expired, tampered, wrong-audience, and unknown-key capabilities", () =>
    Effect.gen(function* () {
      const expired = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: { ...viewer, exp: NOW - 1 },
      });
      const wrongAudience = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: { ...viewer, aud: "wrong-audience" },
      });
      const unknownKey = yield* signSessionFabricCapability({
        privateKey: otherKeys.privateKey,
        keyId: "unknown",
        claims: viewer,
      });
      const valid = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: viewer,
      });
      const [header, payload, signature] = valid.split(".");
      if (header === undefined || payload === undefined || signature === undefined) {
        throw new Error("expected compact JWS");
      }
      const tampered = `${header}.${payload}.${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;

      for (const token of [expired, wrongAudience, unknownKey, tampered]) {
        expect(
          yield* verifySessionFabricCapability({ config, token, nowEpochSeconds: NOW }).pipe(
            Effect.result,
          ),
        ).toMatchObject({ _tag: "Failure" });
      }
    }),
  );

  it.effect("rejects inconsistent or role-oversized capability lifetimes", () =>
    Effect.gen(function* () {
      const invalidClaims = [
        { ...viewer, nbf: NOW + 1 },
        { ...viewer, iat: NOW + 1, exp: NOW + 2 },
        { ...viewer, exp: NOW + 301 },
        { ...controller, exp: NOW + 61 },
        {
          ...base,
          role: "runner" as const,
          scopes: ["session:publish", "session:execute"] as const,
          scaffoldSessionId: "ses_1",
          scaffoldLifecycleEpoch: 7,
          exp: NOW + 901,
        },
      ];
      for (const claims of invalidClaims) {
        const token = yield* signSessionFabricCapability({
          privateKey: keys.privateKey,
          keyId: "current",
          claims: claims as SessionFabricCapabilityClaims,
        });
        expect(
          yield* verifySessionFabricCapability({ config, token, nowEpochSeconds: NOW }).pipe(
            Effect.result,
          ),
        ).toMatchObject({ _tag: "Failure" });
      }
    }),
  );

  it.effect("permits auth-disabled mode only for explicit loopback requests", () =>
    Effect.gen(function* () {
      expect(
        yield* authorizeSessionFabricCapability({
          config: { mode: "disabled" },
          authorization: undefined,
          requestUrl: "http://127.0.0.1:8788/v1/session-fabric/sessions",
          nowEpochSeconds: NOW,
        }),
      ).toBeNull();
      for (const requestUrl of [
        "https://relay.example/v1/session-fabric/sessions",
        "/v1/session-fabric/sessions",
      ]) {
        expect(
          yield* authorizeSessionFabricCapability({
            config: { mode: "disabled" },
            authorization: undefined,
            requestUrl,
            nowEpochSeconds: NOW,
          }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } });
      }
    }),
  );

  it.effect("rejects anonymous access when capabilities are required", () =>
    Effect.gen(function* () {
      expect(
        yield* authorizeSessionFabricCapability({
          config,
          authorization: undefined,
          requestUrl: "https://relay.example/v1/session-fabric/sessions",
          nowEpochSeconds: NOW,
        }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "missing" } });
    }),
  );

  it("extracts capabilities without putting them in URLs", () => {
    expect(
      bearerCapability(new Headers({ authorization: "Bearer header.payload.signature" })),
    ).toBe("header.payload.signature");
    const protocols = sessionFabricWebSocketProtocols("header.payload.signature");
    expect(protocols).toEqual([
      "t3.session-fabric.v1",
      "t3.session-fabric.capability.header.payload.signature",
    ]);
    expect(websocketCapability(protocols.join(", "))).toBe("header.payload.signature");
    expect(websocketCapability("t3.session-fabric.capability.header.payload.signature")).toBeNull();
  });

  it("allows global viewer reads but binds controller and runner authority exactly", () => {
    expect(capabilityCanListDirectory(viewer)).toBe(true);
    expect(capabilityCanListDirectory(controller)).toBe(false);
    expect(capabilityCanReadSession(viewer, snapshot)).toBe(true);
    expect(
      capabilityCanReadSession(viewer, {
        ...snapshot,
        session: { ...snapshot.session, runnerState: "offline" },
      }),
    ).toBe(true);
    expect(capabilityCanReadSession(controller, snapshot)).toBe(true);
    expect(
      capabilityCanReadSession(
        { ...controller, fabricSessionId: SessionFabricSessionId.make("sf:other:thread") },
        snapshot,
      ),
    ).toBe(false);
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: snapshot.session.publication,
        location,
      }),
    ).toBe(true);
    expect(
      capabilityCanControlSession({
        claims: viewer,
        sessionId: controller.fabricSessionId,
        publication: snapshot.session.publication,
        location,
      }),
    ).toBe(false);
    expect(
      capabilityCanControlSession({
        claims: { ...controller, scaffoldLifecycleEpoch: 6 },
        sessionId: controller.fabricSessionId,
        publication: snapshot.session.publication,
        location,
      }),
    ).toBe(false);
    const runnerClaims = {
      ...base,
      role: "runner",
      runnerId: SessionFabricRunnerId.make("runner-1"),
      scopes: ["session:publish", "session:execute"],
      scaffoldSessionId: "ses_1",
      scaffoldLifecycleEpoch: 7,
    } as const satisfies SessionFabricCapabilityClaims;
    const runnerHello = {
      protocolVersion: 1,
      sessionId: controller.fabricSessionId,
      runnerId: SessionFabricRunnerId.make("runner-1"),
      runnerGeneration: 1,
      location,
      publication: "public",
      lastCommittedEventSequence: 0,
      connectedAt: "2026-07-27T00:00:00.000Z",
    } as const;
    expect(capabilityCanRunSession(runnerClaims, runnerHello)).toBe(true);
    expect(
      capabilityCanRunSession({ ...runnerClaims, scaffoldLifecycleEpoch: 6 }, runnerHello),
    ).toBe(false);
    expect(
      capabilityCanRunSession(
        { ...runnerClaims, runnerId: SessionFabricRunnerId.make("runner-other") },
        runnerHello,
      ),
    ).toBe(false);
  });

  it("keeps offline pre-epoch public Scaffold history viewable without granting control", () => {
    expect(isPublicScaffoldViewLocation(legacySnapshot.session.location)).toBe(true);
    expect(isPublicScaffoldLocation(legacySnapshot.session.location)).toBe(false);
    expect(isPublicScaffoldSnapshot(legacySnapshot)).toBe(true);
    expect(capabilityCanReadSession(viewer, legacySnapshot)).toBe(true);
    expect(capabilityCanReadSession(controller, legacySnapshot)).toBe(false);
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: legacySnapshot.session.publication,
        location: legacySnapshot.session.location,
      }),
    ).toBe(false);
  });

  it("lets authenticated viewers read public local sessions but hides local-only sessions", () => {
    const localSnapshot = {
      session: {
        publication: "public",
        location: {
          ...location,
          environmentKind: "local",
          scaffoldSessionId: null,
          scaffoldSessionUrl: null,
          scaffoldLifecycleEpoch: null,
        },
      },
    } as unknown as SessionFabricSnapshot;
    expect(isPublicLocalLocation(localSnapshot.session.location)).toBe(true);
    expect(isPublicSessionRecord(localSnapshot.session)).toBe(true);
    expect(capabilityCanReadSession(viewer, localSnapshot)).toBe(true);
    expect(
      capabilityCanReadSession(viewer, {
        ...localSnapshot,
        session: { ...localSnapshot.session, publication: "local_only" },
      }),
    ).toBe(false);
  });

  it("binds a local runner capability to one actor, environment, thread, runner, and session", () => {
    const localClaims = {
      ...base,
      role: "runner",
      scopes: ["session:publish", "session:execute"],
      fabricSessionId: SessionFabricSessionId.make("sf:local:thread"),
      environmentKind: "local",
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-local"),
      runnerId: SessionFabricRunnerId.make("runner:environment-local"),
      actorId: "user-1",
    } as const satisfies SessionFabricCapabilityClaims;
    expect(
      localRunnerCapabilityMatchesAuthority({
        claims: localClaims,
        sessionId: localClaims.fabricSessionId,
        environmentId: localClaims.environmentId,
        threadId: localClaims.threadId,
        runnerId: localClaims.runnerId,
        actorId: localClaims.actorId,
      }),
    ).toBe(true);
    expect(
      localRunnerCapabilityMatchesAuthority({
        claims: localClaims,
        sessionId: localClaims.fabricSessionId,
        environmentId: localClaims.environmentId,
        threadId: localClaims.threadId,
        runnerId: localClaims.runnerId,
        actorId: "user-other",
      }),
    ).toBe(false);
  });

  it("lets any authenticated controller command an exact public local session without naming its runner", () => {
    const controller = {
      ...base,
      role: "controller",
      scopes: ["session:read", "session:command"],
      fabricSessionId: SessionFabricSessionId.make("sf:local:thread-local"),
      environmentKind: "local",
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-local"),
      actorId: "user-1",
    } as const satisfies SessionFabricCapabilityClaims;
    const location = {
      environmentKind: "local",
      environmentId: controller.environmentId,
      threadId: controller.threadId,
      scaffoldSessionId: null,
      scaffoldSessionUrl: null,
      scaffoldLifecycleEpoch: null,
    } as unknown as SessionFabricSnapshot["session"]["location"];
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: "public",
        location,
      }),
    ).toBe(true);
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: "public",
        location: { ...location, threadId: ThreadId.make("thread-other") },
      }),
    ).toBe(false);
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: "public",
        location: { ...location, environmentId: EnvironmentId.make("environment-other") },
      }),
    ).toBe(false);
    expect(
      capabilityCanControlSession({
        claims: controller,
        sessionId: controller.fabricSessionId,
        publication: "local_only",
        location,
      }),
    ).toBe(false);
    expect("runnerId" in controller).toBe(false);
  });

  it.effect("accepts current and previous verifier keys but rejects an empty key set", () =>
    Effect.gen(function* () {
      const publicKeysJson = yield* encodeUnknownJson(config.publicKeys);
      expect(parseSessionFabricPublicKeys(publicKeysJson)).toEqual(config.publicKeys);
      expect(() => parseSessionFabricPublicKeys("{}")).toThrow("must contain");
      const previousToken = yield* signSessionFabricCapability({
        privateKey: otherKeys.privateKey,
        keyId: "previous",
        claims: viewer,
      });
      expect(
        yield* verifySessionFabricCapability({
          config,
          token: previousToken,
          nowEpochSeconds: NOW,
        }),
      ).toEqual(viewer);
    }),
  );
});
