import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface LocalThreadSettlement {
  /** Authoritative shell version observed when the user marked it Done. */
  readonly threadUpdatedAt: string;
}

interface ThreadSettlementUiState {
  readonly settlementsByThreadKey: Record<string, LocalThreadSettlement>;
  markSettled: (ref: ScopedThreadRef, threadUpdatedAt: string) => void;
  clearSettled: (ref: ScopedThreadRef) => void;
}

/**
 * A disconnected Scaffold cannot persist thread.settle in its own T3 server.
 * Keep that explicit user intent in the browser until newer authoritative
 * thread activity supersedes it. This is presentation state, not runner or
 * orchestration authority.
 */
export function localThreadSettlementApplies(
  settlement: LocalThreadSettlement | undefined,
  threadUpdatedAt: string,
): boolean {
  return settlement?.threadUpdatedAt === threadUpdatedAt;
}

export const useThreadSettlementUiStore = create<ThreadSettlementUiState>()(
  persist(
    (set) => ({
      settlementsByThreadKey: {},
      markSettled: (ref, threadUpdatedAt) =>
        set((state) => ({
          settlementsByThreadKey: {
            ...state.settlementsByThreadKey,
            [scopedThreadKey(ref)]: { threadUpdatedAt },
          },
        })),
      clearSettled: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.settlementsByThreadKey)) return state;
          const { [threadKey]: _removed, ...settlementsByThreadKey } = state.settlementsByThreadKey;
          return { settlementsByThreadKey };
        }),
    }),
    {
      name: "t3code:thread-settlement-ui:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ settlementsByThreadKey: state.settlementsByThreadKey }),
    },
  ),
);
