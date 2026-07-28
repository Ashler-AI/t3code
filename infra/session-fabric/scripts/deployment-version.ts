#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This CI helper validates Wrangler JSON from a temporary file.
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import {
  capturePriorDeploymentVersion,
  isMissingWorkerDeploymentError,
} from "../src/deploymentVersion.ts";

const { values } = NodeUtil.parseArgs({
  args: process.argv.slice(2),
  options: {
    "allow-missing-bootstrap": { type: "boolean", default: false },
    "status-file": { type: "string" },
    "wrangler-error-file": { type: "string" },
  },
  strict: true,
});

const statusFile = values["status-file"];
const wranglerErrorFile = values["wrangler-error-file"];

if ((statusFile === undefined) === (wranglerErrorFile === undefined)) {
  throw new Error("Pass exactly one of --status-file or --wrangler-error-file.");
}

if (wranglerErrorFile !== undefined) {
  const stderr = await NodeFSP.readFile(wranglerErrorFile, "utf8");
  if (!isMissingWorkerDeploymentError(stderr)) {
    throw new Error("Wrangler failure was not the fixed Worker's not-found API response.");
  }
} else {
  const status: unknown = JSON.parse(await NodeFSP.readFile(statusFile!, "utf8"));
  const versionId = capturePriorDeploymentVersion(status, {
    allowMissingBootstrap: values["allow-missing-bootstrap"],
  });
  if (versionId !== null) process.stdout.write(versionId);
}
