import {
  EnvironmentRegistry,
  ScaffoldConnectionRegistration,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { scaffoldTargetFromBinding } from "@t3tools/client-runtime/scaffold";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  ScaffoldCreateParameters,
  scaffoldSessionTransferOperationIdentity,
  scaffoldSessionTransferOperationIdFromSha256,
  type ScaffoldDeployment,
  ScaffoldSessionTransferStartInput,
  ScaffoldWorkspaceMigrationReceipt,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isDesktopLocalConnectionTarget } from "./desktopLocal";
import { connectionAtomRuntime } from "./runtime";

const decodeReceipt = Schema.decodeUnknownOption(ScaffoldWorkspaceMigrationReceipt);
const scheduler = createAtomCommandScheduler();

export interface ScaffoldSessionCopySource {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

const TRANSFER_PATH = "/api/scaffold/session-transfer";
const RECONCILE_PATH = "/api/scaffold/session-transfer/reconcile";
const ABORT_PATH = "/api/scaffold/session-transfer/abort";
const REQUEST_DEADLINE_MS = 30_000;
const OPERATION_DEADLINE_MS = 5 * 60_000;
const RECONCILIATION_WINDOW_MS = 4 * 60_000;
const ABORT_REQUEST_DEADLINE_MS = 15_000;
const RECONCILE_BACKOFF_MAX_MS = 2_000;

export async function scaffoldSessionTransferSeriesId(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly deployment: ScaffoldDeployment;
}): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scaffoldSessionTransferOperationIdentity(input)),
  );
  const digestHex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return scaffoldSessionTransferOperationIdFromSha256(digestHex);
}

/** @deprecated Use scaffoldSessionTransferSeriesId to make its logical identity explicit. */
export const scaffoldSessionTransferOperationId = scaffoldSessionTransferSeriesId;

function receiptBelongsToSeries(receiptOperationId: string, seriesOperationId: string): boolean {
  if (receiptOperationId === seriesOperationId) return true;
  const attemptPrefix = `${seriesOperationId}:attempt:`;
  if (!receiptOperationId.startsWith(attemptPrefix)) return false;
  const generationText = receiptOperationId.slice(attemptPrefix.length);
  if (!/^(?:[2-9]|[1-9][0-9]+)$/.test(generationText)) return false;
  const generation = Number(generationText);
  return Number.isSafeInteger(generation);
}

function assertLocalPreparedConnection(
  prepared: PreparedConnection | null,
  source: ScaffoldSessionCopySource,
): void {
  if (prepared === null) {
    throw new Error("The selected local environment is not connected.");
  }
  if (prepared.environmentId !== source.environmentId) {
    throw new Error("The selected local environment does not match this session.");
  }
  if (
    prepared.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(prepared.target)
  ) {
    throw new Error("Only a connected local environment can copy a session to Scaffold.");
  }
  if (prepared.target.environmentId !== source.environmentId) {
    throw new Error("The selected local environment has mismatched connection identity.");
  }
  if (prepared.httpAuthorization?._tag === "Dpop") {
    throw new Error("This local environment uses unsupported request authorization.");
  }
}

function validateReceipt(
  receipt: ScaffoldWorkspaceMigrationReceipt,
  input: {
    readonly deployment: ScaffoldDeployment;
    readonly seriesOperationId: string;
    readonly source: ScaffoldSessionCopySource;
  },
): void {
  const expectedSourceGlobalId = `sf:${input.source.environmentId}:${input.source.threadId}`;
  const expectedDestinationGlobalId = `sf:${receipt.destination.environmentId}:${receipt.destination.threadId}`;
  if (
    !receiptBelongsToSeries(receipt.operationId, input.seriesOperationId) ||
    receipt.source.environmentId !== input.source.environmentId ||
    receipt.source.projectId !== input.source.projectId ||
    receipt.source.threadId !== input.source.threadId ||
    receipt.source.globalSessionId !== expectedSourceGlobalId ||
    receipt.binding.deployment !== input.deployment ||
    receipt.binding.sessionId !== receipt.sessionId ||
    receipt.binding.environmentId !== receipt.destination.environmentId ||
    (receipt.binding.status !== "ready" && receipt.binding.status !== "agent_running") ||
    receipt.destination.globalSessionId !== expectedDestinationGlobalId ||
    receipt.destination.globalSessionId === receipt.source.globalSessionId ||
    receipt.destination.environmentId === input.source.environmentId ||
    receipt.destination.projectId === input.source.projectId ||
    receipt.destination.threadId === input.source.threadId ||
    receipt.destination.ompSessionId === receipt.source.ompSessionId
  ) {
    throw new Error("Scaffold returned a session copy receipt with mismatched identity.");
  }
}

export async function requestScaffoldSessionCopy(
  input: {
    readonly deployment: ScaffoldDeployment;
    readonly source: ScaffoldSessionCopySource;
    readonly prepared: PreparedConnection | null;
  },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<ScaffoldWorkspaceMigrationReceipt> {
  assertLocalPreparedConnection(input.prepared, input.source);
  const prepared = input.prepared;
  if (prepared === null) {
    throw new Error("The selected local environment is not connected.");
  }
  const seriesOperationId = await scaffoldSessionTransferSeriesId({
    sourceEnvironmentId: input.source.environmentId,
    sourceThreadId: input.source.threadId,
    deployment: input.deployment,
  });
  const requestBody = JSON.stringify(
    new ScaffoldSessionTransferStartInput({
      operationId: seriesOperationId,
      deployment: input.deployment,
      sourceThreadId: input.source.threadId,
      create: new ScaffoldCreateParameters({}),
    }),
  );
  const authorization = prepared.httpAuthorization;
  const operationDeadline = Date.now() + OPERATION_DEADLINE_MS;
  const postOperation = async (
    path: typeof TRANSFER_PATH | typeof RECONCILE_PATH | typeof ABORT_PATH,
    requestDeadlineMs = REQUEST_DEADLINE_MS,
  ): Promise<
    | { readonly _tag: "Response"; readonly response: Response; readonly body: unknown }
    | { readonly _tag: "Ambiguous" }
  > => {
    const remainingMs = operationDeadline - Date.now();
    if (remainingMs <= 0) return { _tag: "Ambiguous" };
    const controller = new AbortController();
    const deadline = globalThis.setTimeout(
      () => controller.abort(),
      Math.min(requestDeadlineMs, remainingMs),
    );
    try {
      try {
        const response = await fetchImpl(environmentEndpointUrl(prepared.httpBaseUrl, path), {
          method: "POST",
          credentials: authorization === null ? "include" : "omit",
          headers: {
            "content-type": "application/json",
            ...(authorization?._tag === "Bearer"
              ? { authorization: `Bearer ${authorization.token}` }
              : {}),
          },
          body: requestBody,
          signal: controller.signal,
        });
        try {
          return { _tag: "Response", response, body: await response.json() };
        } catch {
          return { _tag: "Ambiguous" };
        }
      } catch {
        return { _tag: "Ambiguous" };
      }
    } finally {
      globalThis.clearTimeout(deadline);
    }
  };
  const receiptFromResponse = (
    result: Awaited<ReturnType<typeof postOperation>>,
  ): ScaffoldWorkspaceMigrationReceipt | undefined => {
    if (result._tag !== "Response" || !result.response.ok) return undefined;
    const decoded = decodeReceipt(result.body);
    if (Option.isNone(decoded)) return undefined;
    validateReceipt(decoded.value, { ...input, seriesOperationId });
    return decoded.value;
  };
  const errorCode = (result: Awaited<ReturnType<typeof postOperation>>): string | undefined => {
    if (
      result._tag !== "Response" ||
      result.body === null ||
      typeof result.body !== "object" ||
      !("error" in result.body)
    ) {
      return undefined;
    }
    return typeof result.body.error === "string" ? result.body.error : undefined;
  };

  const started = await postOperation(TRANSFER_PATH);
  const startedReceipt = receiptFromResponse(started);
  if (startedReceipt !== undefined) return startedReceipt;
  if (
    started._tag === "Response" &&
    started.response.status < 500 &&
    errorCode(started) !== "workspace_migration_source_reconciliation_pending" &&
    errorCode(started) !== "workspace_migration_source_transfer_in_progress"
  ) {
    throw new Error("The local T3 session copy service could not copy this session.");
  }

  const reconciliationDeadline = Math.min(
    operationDeadline - ABORT_REQUEST_DEADLINE_MS * 2,
    Date.now() + RECONCILIATION_WINDOW_MS,
  );
  let reconciliationBackoffMs = 250;
  while (Date.now() < reconciliationDeadline) {
    const reconciled = await postOperation(RECONCILE_PATH);
    const reconciledReceipt = receiptFromResponse(reconciled);
    if (reconciledReceipt !== undefined) return reconciledReceipt;
    if (errorCode(reconciled) === "workspace_migration_source_operation_aborted") {
      throw new Error("The Scaffold session copy was safely aborted before completion.");
    }
    if (
      reconciled._tag === "Response" &&
      reconciled.response.status < 500 &&
      errorCode(reconciled) !== "workspace_migration_source_reconciliation_pending" &&
      errorCode(reconciled) !== "workspace_migration_source_reconciliation_raced"
    ) {
      throw new Error("The local T3 session copy service could not reconcile this session copy.");
    }
    const delayMs = Math.min(reconciliationBackoffMs, reconciliationDeadline - Date.now());
    if (delayMs > 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
    reconciliationBackoffMs = Math.min(reconciliationBackoffMs * 2, RECONCILE_BACKOFF_MAX_MS);
  }

  const aborted = await postOperation(ABORT_PATH, ABORT_REQUEST_DEADLINE_MS);
  const finalReconciliation = await postOperation(RECONCILE_PATH, ABORT_REQUEST_DEADLINE_MS);
  const completedDuringAbort = receiptFromResponse(finalReconciliation);
  if (completedDuringAbort !== undefined) return completedDuringAbort;
  if (
    errorCode(finalReconciliation) === "workspace_migration_source_operation_aborted" ||
    (aborted._tag === "Response" && aborted.response.ok)
  ) {
    throw new Error("The Scaffold session copy was safely aborted before completion.");
  }
  throw new Error("The local T3 session copy service could not determine the transfer outcome.");
}

export async function copyScaffoldSessionAndRegister(input: {
  readonly deployment: ScaffoldDeployment;
  readonly source: ScaffoldSessionCopySource;
  readonly prepared: PreparedConnection | null;
  readonly register: (
    binding: ScaffoldWorkspaceMigrationReceipt["binding"],
  ) => Promise<{ readonly environmentId: EnvironmentId }>;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }> {
  const receipt = await requestScaffoldSessionCopy(input, input.fetchImpl);
  const registered = await input.register(receipt.binding);
  if (registered.environmentId !== receipt.binding.environmentId) {
    throw new Error("The registered Scaffold environment has mismatched identity.");
  }
  return {
    environmentId: registered.environmentId,
    threadId: receipt.destination.threadId,
  };
}

export function scaffoldSessionCopyRegistration(
  binding: ScaffoldWorkspaceMigrationReceipt["binding"],
  label?: string,
): ScaffoldConnectionRegistration {
  return new ScaffoldConnectionRegistration({
    target: scaffoldTargetFromBinding(binding, label?.trim() || "Scaffold sandbox"),
  });
}

/** Registers only credential-free lifecycle identity returned by the copy endpoint. */
export const registerScaffoldSessionCopy = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:register-scaffold-session-copy",
  scheduler,
  concurrency: { mode: "singleFlight", key: (input) => input.binding.environmentId },
  execute: (input: {
    readonly binding: ScaffoldWorkspaceMigrationReceipt["binding"];
    readonly label?: string;
  }) =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      const registration = scaffoldSessionCopyRegistration(input.binding, input.label);
      yield* registry.register(registration);
      return registration.target;
    }),
});
