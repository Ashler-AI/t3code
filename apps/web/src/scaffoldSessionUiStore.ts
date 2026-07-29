import type {
  EnvironmentId,
  ProjectId,
  ScaffoldDeployment,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import type { ScaffoldLifecycleAction } from "@t3tools/client-runtime/scaffold";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DraftId } from "./composerDraftStore";
import { createMemoryStorage } from "./lib/storage";

export type ScaffoldSessionUiPhase = "creating" | "ready" | "resuming" | "paused" | "failed";

export const SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE =
  "Scaffold connected to a different target. Start a new session.";
export const SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE =
  "This saved Scaffold session did not record its target. Start a new session.";
export const SCAFFOLD_SESSION_STOPPED_MESSAGE =
  "This Scaffold session has stopped. Start a new session.";
export const SCAFFOLD_SESSION_FAILED_MESSAGE =
  "This Scaffold session failed and cannot be resumed. Start a new session.";

export interface ScaffoldSessionUiEntry {
  readonly draftId: DraftId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly deployment: ScaffoldDeployment;
  readonly actionId: string;
  readonly phase: ScaffoldSessionUiPhase;
  readonly environmentId: EnvironmentId | null;
  readonly sessionId: string | null;
  readonly lifecycleEpoch: number;
  readonly links: ScaffoldSessionLinks | null;
  readonly error: string | null;
  readonly terminal?: boolean;
  readonly createdAt: string;
}

export function scaffoldSessionUiEntryFromCreateAction(
  action: ScaffoldLifecycleAction,
): ScaffoldSessionUiEntry | null {
  if (
    action.kind !== "create" ||
    action.deployment === undefined ||
    action.draftId === undefined ||
    action.sourceEnvironmentId === undefined ||
    action.sourceProjectId === undefined
  ) {
    return null;
  }
  return {
    draftId: DraftId.make(action.draftId),
    sourceEnvironmentId: action.sourceEnvironmentId,
    sourceProjectId: action.sourceProjectId,
    deployment: action.deployment,
    actionId: action.actionId,
    phase: "creating",
    environmentId: null,
    sessionId: action.sessionId,
    lifecycleEpoch: action.expectedLifecycleEpoch,
    links: null,
    error: null,
    terminal: false,
    createdAt: action.createdAt,
  };
}

export function scaffoldSessionUiEntryMatchesCreateAction(
  entry: ScaffoldSessionUiEntry,
  action: ScaffoldLifecycleAction,
): boolean {
  const recovered = scaffoldSessionUiEntryFromCreateAction(action);
  return (
    recovered !== null &&
    entry.draftId === recovered.draftId &&
    entry.sourceEnvironmentId === recovered.sourceEnvironmentId &&
    entry.sourceProjectId === recovered.sourceProjectId &&
    entry.deployment === recovered.deployment &&
    entry.actionId === recovered.actionId &&
    entry.createdAt === recovered.createdAt
  );
}

export function scaffoldSessionUiEntryMatchesPendingCreateAction(
  entry: ScaffoldSessionUiEntry,
  action: ScaffoldLifecycleAction,
): boolean {
  return (
    scaffoldSessionUiEntryMatchesCreateAction(entry, action) && entry.sessionId === action.sessionId
  );
}

interface ScaffoldSessionUiState {
  readonly entriesByDraftId: Record<string, ScaffoldSessionUiEntry>;
  readonly volatileCreateActionsByDraftId: Record<string, ScaffoldLifecycleAction>;
  begin: (
    entry: Omit<
      ScaffoldSessionUiEntry,
      "phase" | "environmentId" | "lifecycleEpoch" | "links" | "error" | "terminal"
    >,
  ) => void;
  connected: (draftId: DraftId, binding: ScaffoldEnvironmentBinding) => void;
  rebindCreating: (
    draftId: DraftId,
    actionId: string,
    sessionId: string,
    lifecycleEpoch: number,
  ) => void;
  terminal: (
    draftId: DraftId,
    observation: {
      readonly sessionId: string;
      readonly lifecycleEpoch: number;
      readonly status: "stopped" | "failed";
    },
  ) => void;
  fail: (draftId: DraftId, error: string) => void;
  setPhase: (draftId: DraftId, phase: ScaffoldSessionUiPhase) => void;
  rememberVolatileCreateAction: (action: ScaffoldLifecycleAction) => void;
  forgetVolatileCreateAction: (draftId: DraftId) => void;
  remove: (draftId: DraftId) => void;
}

const storage = createJSONStorage(() =>
  typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
);

export const useScaffoldSessionUiStore = create<ScaffoldSessionUiState>()(
  persist(
    (set) => ({
      entriesByDraftId: {},
      volatileCreateActionsByDraftId: {},
      begin: (entry) =>
        set((state) => ({
          entriesByDraftId: {
            ...state.entriesByDraftId,
            [entry.draftId]: {
              ...entry,
              phase: "creating",
              environmentId: null,
              lifecycleEpoch: 0,
              links: null,
              error: null,
              terminal: false,
            },
          },
        })),
      connected: (draftId, binding) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current) return state;
          if (current.terminal === true) return state;
          if (binding.deployment !== current.deployment) {
            return {
              entriesByDraftId: {
                ...state.entriesByDraftId,
                [draftId]: {
                  ...current,
                  phase: "failed",
                  environmentId: null,
                  lifecycleEpoch: 0,
                  links: null,
                  error: SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE,
                },
              },
            };
          }
          if (binding.status === "stopped" || binding.status === "failed") {
            return {
              entriesByDraftId: {
                ...state.entriesByDraftId,
                [draftId]: {
                  ...current,
                  phase: "failed",
                  environmentId: binding.environmentId,
                  sessionId: binding.sessionId,
                  lifecycleEpoch: binding.lifecycleEpoch,
                  links: binding.links,
                  error:
                    binding.status === "stopped"
                      ? SCAFFOLD_SESSION_STOPPED_MESSAGE
                      : SCAFFOLD_SESSION_FAILED_MESSAGE,
                  terminal: true,
                },
              },
            };
          }
          if (current.phase === "paused" && binding.status !== "paused") {
            return state;
          }
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: {
                ...current,
                phase: binding.status === "paused" ? "paused" : "ready",
                environmentId: binding.environmentId,
                sessionId: binding.sessionId,
                lifecycleEpoch: binding.lifecycleEpoch,
                links: binding.links,
                error: null,
                terminal: false,
              },
            },
          };
        }),
      rebindCreating: (draftId, actionId, sessionId, lifecycleEpoch) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || current.phase !== "creating" || current.actionId !== actionId) {
            return state;
          }
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: {
                ...current,
                sessionId,
                lifecycleEpoch,
                environmentId: null,
                links: null,
                error: null,
                terminal: false,
              },
            },
          };
        }),
      terminal: (draftId, observation) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: {
                ...current,
                phase: "failed",
                environmentId: null,
                sessionId: observation.sessionId,
                lifecycleEpoch: observation.lifecycleEpoch,
                links: null,
                error:
                  observation.status === "stopped"
                    ? SCAFFOLD_SESSION_STOPPED_MESSAGE
                    : SCAFFOLD_SESSION_FAILED_MESSAGE,
                terminal: true,
              },
            },
          };
        }),
      fail: (draftId, error) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || current.terminal === true) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, phase: "failed", error },
            },
          };
        }),
      setPhase: (draftId, phase) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || current.terminal === true || current.phase === phase) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, phase },
            },
          };
        }),
      rememberVolatileCreateAction: (action) =>
        set((state) => {
          const entry = scaffoldSessionUiEntryFromCreateAction(action);
          if (entry === null) return state;
          return {
            volatileCreateActionsByDraftId: {
              ...state.volatileCreateActionsByDraftId,
              [entry.draftId]: action,
            },
          };
        }),
      forgetVolatileCreateAction: (draftId) =>
        set((state) => {
          if (!state.volatileCreateActionsByDraftId[draftId]) return state;
          const volatileCreateActionsByDraftId = { ...state.volatileCreateActionsByDraftId };
          delete volatileCreateActionsByDraftId[draftId];
          return { volatileCreateActionsByDraftId };
        }),
      remove: (draftId) =>
        set((state) => {
          if (!state.entriesByDraftId[draftId] && !state.volatileCreateActionsByDraftId[draftId]) {
            return state;
          }
          const entriesByDraftId = { ...state.entriesByDraftId };
          const volatileCreateActionsByDraftId = { ...state.volatileCreateActionsByDraftId };
          delete entriesByDraftId[draftId];
          delete volatileCreateActionsByDraftId[draftId];
          return { entriesByDraftId, volatileCreateActionsByDraftId };
        }),
    }),
    {
      name: "t3code:scaffold-session-ui:v1",
      storage,
      partialize: (state) => ({ entriesByDraftId: state.entriesByDraftId }),
    },
  ),
);

export function scaffoldSessionForEnvironment(
  entries: Readonly<Record<string, ScaffoldSessionUiEntry>>,
  environmentId: EnvironmentId,
): ScaffoldSessionUiEntry | null {
  return Object.values(entries).find((entry) => entry.environmentId === environmentId) ?? null;
}
