import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  localThreadSettlementApplies,
  useThreadSettlementUiStore,
} from "./threadSettlementUiStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("scaffold-environment"),
  ThreadId.make("thread-1"),
);

describe("thread settlement UI state", () => {
  beforeEach(() => {
    useThreadSettlementUiStore.setState({ settlementsByThreadKey: {} });
  });

  it("keeps a disconnected Scaffold settle until newer authoritative activity arrives", () => {
    useThreadSettlementUiStore.getState().markSettled(THREAD_REF, "2026-07-28T12:00:00.000Z");

    const settlement =
      useThreadSettlementUiStore.getState().settlementsByThreadKey["scaffold-environment:thread-1"];
    expect(localThreadSettlementApplies(settlement, "2026-07-28T12:00:00.000Z")).toBe(true);
    expect(localThreadSettlementApplies(settlement, "2026-07-28T12:00:01.000Z")).toBe(false);
  });

  it("clears the local settle when the user moves the thread back to active", () => {
    const store = useThreadSettlementUiStore.getState();
    store.markSettled(THREAD_REF, "2026-07-28T12:00:00.000Z");
    useThreadSettlementUiStore.getState().clearSettled(THREAD_REF);

    expect(useThreadSettlementUiStore.getState().settlementsByThreadKey).toEqual({});
  });
});
