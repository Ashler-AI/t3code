import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient, RpcMessage } from "effect/unstable/rpc";

let nextWsRpcRequestId = 0;

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup, {
  generateRequestId: () => RpcMessage.RequestId(String(nextWsRpcRequestId++)),
});
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
