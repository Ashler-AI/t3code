#!/usr/bin/env node
// @effect-diagnostics globalFetch:off - This standalone deployment probe intentionally uses the host HTTP and WebSocket clients.
import * as NodeUtil from "node:util";

import { runDeploymentSmoke } from "../src/deploymentSmoke.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "relay-url": { type: "string" },
    marker: { type: "string" },
    timeout: { type: "string", default: "30000" },
  },
});

if (values["relay-url"] === undefined || values.marker === undefined) {
  throw new Error(
    "Usage: pnpm smoke:deployment --relay-url <url> --marker <unique-marker> [--timeout <milliseconds>]",
  );
}

const timeoutMs = Number(values.timeout);
const result = await runDeploymentSmoke({
  relayUrl: new URL(values["relay-url"]),
  marker: values.marker,
  timeoutMs,
  fetch,
  createWebSocket: (url) => new WebSocket(url),
});

process.stdout.write(
  `${JSON.stringify({ ok: true, marker: result.marker, sessionId: result.sessionId })}\n`,
);
