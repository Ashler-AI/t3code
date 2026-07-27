#!/usr/bin/env node
// @effect-diagnostics globalFetch:off - This standalone deployment probe intentionally uses the host HTTP and WebSocket clients.
import * as NodeUtil from "node:util";

import { runDeploymentSmoke } from "../src/deploymentSmoke.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "relay-url": { type: "string" },
    "scaffold-origin": { type: "string" },
    marker: { type: "string" },
    timeout: { type: "string", default: "30000" },
  },
});

if (values["relay-url"] === undefined || values.marker === undefined) {
  throw new Error(
    "Usage: pnpm smoke:deployment --relay-url <url> --scaffold-origin <origin> --marker <unique-marker> [--timeout <milliseconds>]",
  );
}

const timeoutMs = Number(values.timeout);
const scaffoldOrigin =
  values["scaffold-origin"] ?? process.env.SESSION_FABRIC_SMOKE_SCAFFOLD_ORIGIN;
const viewerCapability = process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY;
const runnerCapability = process.env.SESSION_FABRIC_SMOKE_RUNNER_CAPABILITY;
if (
  scaffoldOrigin === undefined ||
  viewerCapability === undefined ||
  runnerCapability === undefined
) {
  throw new Error(
    "Required-auth deployment smoke needs --scaffold-origin (or SESSION_FABRIC_SMOKE_SCAFFOLD_ORIGIN) plus separate SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY and SESSION_FABRIC_SMOKE_RUNNER_CAPABILITY values.",
  );
}
const result = await runDeploymentSmoke({
  relayUrl: new URL(values["relay-url"]),
  marker: values.marker,
  timeoutMs,
  fetch,
  scaffoldOrigin,
  viewerCapability,
  runnerCapability,
  createWebSocket: (url, protocols) =>
    new WebSocket(url, protocols === undefined ? undefined : [...protocols]),
});

process.stdout.write(
  `${JSON.stringify({ ok: true, marker: result.marker, sessionId: result.sessionId })}\n`,
);
