import type {
  EnvironmentId,
  ProjectId,
  ScaffoldDeployment,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { createMemoryStorage } from "./lib/storage";

export type ScaffoldSessionUiPhase = "creating" | "ready" | "resuming" | "paused" | "failed";

export interface ScaffoldSessionUiEntry {
  readonly draftId: DraftId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly deployment: ScaffoldDeployment;
  readonly actionId: string;
  readonly phase: ScaffoldSessionUiPhase;
  readonly queuedSend: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly sessionId: string | null;
  readonly lifecycleEpoch: number;
  readonly links: ScaffoldSessionLinks | null;
  readonly error: string | null;
  readonly createdAt: string;
}

interface ScaffoldSessionUiState {
  readonly entriesByDraftId: Record<string, ScaffoldSessionUiEntry>;
  begin: (
    entry: Omit<
      ScaffoldSessionUiEntry,
      "phase" | "queuedSend" | "environmentId" | "lifecycleEpoch" | "links" | "error"
    >,
  ) => void;
  connected: (draftId: DraftId, binding: ScaffoldEnvironmentBinding) => void;
  fail: (draftId: DraftId, error: string) => void;
  queueSend: (draftId: DraftId) => void;
  clearQueuedSend: (draftId: DraftId) => void;
  setPhase: (draftId: DraftId, phase: ScaffoldSessionUiPhase) => void;
  remove: (draftId: DraftId) => void;
}

const storage = createJSONStorage(() =>
  typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
);

export const useScaffoldSessionUiStore = create<ScaffoldSessionUiState>()(
  persist(
    (set) => ({
      entriesByDraftId: {},
      begin: (entry) =>
        set((state) => ({
          entriesByDraftId: {
            ...state.entriesByDraftId,
            [entry.draftId]: {
              ...entry,
              phase: "creating",
              queuedSend: false,
              environmentId: null,
              lifecycleEpoch: 0,
              links: null,
              error: null,
            },
          },
        })),
      connected: (draftId, binding) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: {
                ...current,
                phase:
                  binding.status === "paused" || binding.status === "stopped" ? "paused" : "ready",
                environmentId: binding.environmentId,
                sessionId: binding.sessionId,
                lifecycleEpoch: binding.lifecycleEpoch,
                links: binding.links,
                error: null,
              },
            },
          };
        }),
      fail: (draftId, error) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, phase: "failed", error },
            },
          };
        }),
      queueSend: (draftId) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || current.queuedSend) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, queuedSend: true },
            },
          };
        }),
      clearQueuedSend: (draftId) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || !current.queuedSend) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, queuedSend: false },
            },
          };
        }),
      setPhase: (draftId, phase) =>
        set((state) => {
          const current = state.entriesByDraftId[draftId];
          if (!current || current.phase === phase) return state;
          return {
            entriesByDraftId: {
              ...state.entriesByDraftId,
              [draftId]: { ...current, phase },
            },
          };
        }),
      remove: (draftId) =>
        set((state) => {
          if (!state.entriesByDraftId[draftId]) return state;
          const entriesByDraftId = { ...state.entriesByDraftId };
          delete entriesByDraftId[draftId];
          return { entriesByDraftId };
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
