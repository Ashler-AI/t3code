import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("Scaffold websocket RPC contracts", () => {
  it("keeps pause on websocket while connection preparation remains HTTP-only", () => {
    expect(WS_METHODS.scaffoldPause).toBe("scaffold.pause");
    expect(Object.hasOwn(WS_METHODS, "scaffoldPrepareConnection")).toBe(false);
    expect(WsRpcGroup.requests.has("scaffold.pause")).toBe(true);
    expect(WsRpcGroup.requests.has("scaffold.prepareConnection")).toBe(false);
  });
});
