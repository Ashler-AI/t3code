# Multiplayer session fabric implementation coordination

Active objective: prove that two fresh browser clients can share one local Pi/OMP session and one Scaffold session without browser storage authority, then discover either session semantically from a third fresh session and import its transcript/code/continuation context.

## Shared seams owned by the existing harness thread

- `apps/server/src/orchestration/**`: committed event stream and command receipts
- `packages/client-runtime/src/session-source/source.ts`: injectable UI session source contract
- `packages/client-runtime/src/session-source/directEnvironment.ts`: direct local source
- `packages/client-runtime/src/scaffold/**`: managed Scaffold connection
- current OMP provider, account, UI, worktree, and Scaffold changes

Do not revert or broadly rewrite those changes. Session-fabric integration should use narrow additive edits at their composition points.

## Session-fabric lane ownership

- `packages/contracts/src/sessionFabric.ts` and focused tests
- `infra/relay/src/sessionFabric/**`, bindings, migrations, and focused tests
- `apps/server/src/sessionFabric/**` bridge and focused tests
- `packages/client-runtime/src/session-source/relaySessionFabric.ts` and focused tests
- semantic search/context-handoff modules under the Relay and MCP session-reference toolkit
- Ashler GCS broker/Terraform and Scaffold enrollment wiring once local gates pass

## Coordination contract

- Stable event IDs, source sequences, and `commandId` receipts from the harness thread are authoritative.
- Publish only after local transaction/projection/receipt commit.
- Relay/client source remains injectable; IndexedDB is a disposable cache, never the proof authority.
- A local-to-Scaffold move preserves the global session ID and increments runner generation.
- Accepted command receipts preserve the original orchestration result sequence, including duplicate `commandId` submissions.
- The current OMP terminal fixture is an ACP `tool_call` with `kind="execute"`, `title="Terminal"`, and `rawInput`/`rawOutput`. Native ACP terminal create/output/wait/release events are not a required fabric boundary until OMP emits them.
- Before changing a shared-seam file, inspect the current diff and keep the edit additive and narrowly scoped.
- Before Cloudflare or GCS apply, publish the resource plan and wait for explicit confirmation.
