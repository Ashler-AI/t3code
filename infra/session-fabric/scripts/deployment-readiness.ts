#!/usr/bin/env node
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off - This bounded host-side probe verifies a deployed Durable Object instance.
import * as NodeUtil from "node:util";

import { waitForDeploymentCoordinatorReadiness } from "../src/deploymentSmoke.ts";

const { values } = NodeUtil.parseArgs({
  args: process.argv.slice(2).filter((value, index) => !(index === 0 && value === "--")),
  options: {
    "relay-url": { type: "string" },
    timeout: { type: "string", default: "120000" },
    "allow-missing-bootstrap": { type: "boolean", default: false },
  },
  strict: true,
});

if (values["relay-url"] === undefined) {
  throw new Error(
    "Usage: pnpm smoke:readiness --relay-url <url> [--timeout <milliseconds>] [--allow-missing-bootstrap]",
  );
}
const viewerCapability = process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY;
if (viewerCapability === undefined || viewerCapability.length === 0) {
  throw new Error("SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY is required.");
}

await waitForDeploymentCoordinatorReadiness({
  relayUrl: new URL(values["relay-url"]),
  timeoutMs: Number(values.timeout),
  fetch,
  viewerCapability,
  allowMissingBootstrap: values["allow-missing-bootstrap"],
});

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
