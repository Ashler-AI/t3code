# Ashler T3 Code Product Fork: OMP and Scaffold Plan

## Status

- Decision: proceed with the Ashler product fork.
- Fork: `Ashler-AI/t3code`.
- Upstream: `pingdotgg/t3code`.
- Planning base: upstream `main` at `ece05087a70e94efcd57441337fa1249559362ba` (2026-07-24).
- Existing Ashler OMP UI remains the working harness during implementation and parity testing. There is no cutover in this plan until the fork passes the exit criteria in Phase 6.

## Purpose

Use T3 Code as Ashler's UI, local/remote environment, durable product-state, and desktop substrate while keeping OMP as the agent harness. The resulting product must support:

- local OMP sessions in a browser or macOS app;
- local native Codex and Claude Code sessions when the user explicitly chooses those harnesses;
- Scaffold as a first-class managed execution environment;
- direct client-to-sandbox traffic after Scaffold creates or resumes the sandbox;
- local OpenAI, Anthropic, and Bifrost-backed OMP accounts and plan usage;
- centrally brokered OpenAI and Anthropic access inside Scaffold;
- attachments, streaming reasoning, tools, subagents, steering, annotations, terminal access, and code review;
- reliable reconnect, cached history, lifecycle state, handoff, and observability.

This is a product fork with a deliberately small upstream-core patch surface. It is not a build-time skin over an unmodified T3 checkout: provider registration, managed-environment preparation, app identity, auth, and telemetry currently have static or closed seams that require a bounded set of changes to upstream-owned files.

## Product boundary

```text
Ashler web or desktop client
  ├─ local T3 server ──────────────┐
  │                                │
  └─ Scaffold lifecycle API        │ create/resume/pause only
         └─ direct endpoint/token ─┼─> T3 server in one sandbox
                                  │
                                  └─> OMP provider driver
                                         └─> Pi / OMP runtime
                                                ├─ account routing
                                                ├─ model/provider routing
                                                ├─ tools and skills
                                                ├─ subagents
                                                └─ continuation state
```

The Scaffold control plane is never the transcript, tool, file, terminal, or streaming data path. After lifecycle preparation, the client connects directly to the selected sandbox T3 server over authenticated HTTP/WebSocket.

## Accepted decisions

### Harnesses and runtime profiles

- A session's execution environment and harness are chosen at creation and are immutable afterward.
- The local runtime offers:
  - `OMP` by default;
  - `Codex` using the installed Codex CLI and its local login;
  - `Claude Code` using the installed Claude CLI and its local login.
- Scaffold images ship with and expose only OMP.
- Model and effort can change during an OMP session and persist for later turns until changed again.
- Native Codex/Claude model switching follows the provider adapter's actual capability. The UI must not imply that an unsupported in-session change succeeded.
- OMP decides what subagent to create for a task, including its model and effort. Subagents share the session workspace, matching the current OpenCode behavior.
- OMP owns agent-turn logic. T3 must not duplicate OMP's tool loop, advisor selection, subagent policy, or account router.

### Environment and session topology

- One local T3 server represents the local machine and may host many local threads/worktrees.
- One Scaffold sandbox represents one T3 execution environment and, initially, one visible agent thread.
- The locally hosted Ashler UI may catalog both the local environment and many Scaffold environments.
- A UI hosted inside a Scaffold sandbox shows only that sandbox's thread. It must not become a coordinator that nests or proxies other sandbox sessions.
- The future unified hosted Scaffold session index and shared Durable Object transcript are explicitly deferred.
- Multiple browser clients may connect to the same T3 server. T3's server/event projection is authoritative; clients are views, not session owners.

### Worktrees and diffs

- T3 owns local worktree creation, naming, metadata, cleanup prompts, source-control state, and checkpoints.
- A new local agent thread defaults to a new worktree based on the selected repository's current `HEAD`. During the initial Ashler rollout, the default repository is `ashler-platform`.
- OMP and native harnesses receive a prepared `cwd`; they do not create a second worktree.
- Scaffold creates a new sandbox rather than a local worktree.
- The code-review view compares the session workspace to the PR base. It does not use the branch that happened to launch the UI as the comparison base.
- Subagents edit the same worktree/sandbox workspace as the main agent.

### Accounts and models

- T3 sees OMP as one logical provider with namespaced models. OMP owns OpenAI, Anthropic, and Bifrost routing behind that provider.
- Local native Codex and Claude Code continue to use their respective CLI account stores.
- Local OMP uses Ashler's local connected-account store. Account login/removal and usage are global to the local OMP runtime, not scoped to the currently open session.
- Scaffold OMP uses Scaffold's central auth broker. Raw subscription OAuth credentials are never copied to a sandbox.
- Anthropic Max/Pro traffic through the broker must use the approved Claude Code-compatible client behavior. Provider-policy and protocol compatibility must be validated before production rollout.
- Account assignment is sticky for the lifetime of an OMP session.
- New sessions are distributed across eligible accounts using current quota, recent assignment pressure, provider health, and configured weights.
- Ordinary rate limiting retries on the same account. Confirmed hard exhaustion or revoked credentials may trigger exactly one visible reassignment to another compatible account.
- The UI shows masked account identity and the reason when reassignment occurs.
- Usage is cached independently of threads. Opening Command-K shows the last successful snapshot immediately and synchronously starts a refresh.
- A refresh failure is nonfatal: preserve cached usage, show its age, and show a warning without converting a completed agent turn into an error.
- Login commands remain enabled during active turns and affect future sessions only.
- Product copy uses `ChatGPT` and `Claude`; it does not expose a duplicate generic `OpenAI account` item or the removed `Spark · 7-day quota` pseudo-account.
- The OMP catalog is centrally curated and dynamically delivered. Initial policy exposes the current GPT 5.6 family, Sonnet/Fable 5, and approved recent Bifrost Kimi/Grok models without hard-coding the catalog into the web bundle.
- Default advisor selection is cross-provider: an OpenAI primary model gets an Anthropic advisor, an Anthropic primary model gets an OpenAI advisor, and other providers use a policy-selected advisor. Terra or Sonnet at high effort are the preferred defaults when available.

### UX and interaction

- Reuse T3's visual system, command palette, notification sounds, and desktop notification behavior.
- The left sidebar is session-first and uses compact rows:
  - yellow pulsing status while a turn is running or an environment is preparing;
  - blue unread/attention indicator after new content or a question;
  - no status dot when idle and read;
  - a second row only for Scaffold, with a cloud marker and direct Session, Web, and Tilt links.
- Opening a session does not reorder it.
- Settled/done sessions appear in a separate group at the bottom. Settling a Scaffold thread idempotently pauses its sandbox. Sending a new message unsets Done and resumes it.
- The session list occupies the full left rail and has a top-right New Session action.
- New local and Scaffold sessions are provisional UI records immediately. Worktree/sandbox preparation runs in the background and never blocks navigation or creation of another session.
- A message entered during preparation is placed in a durable client outbox and sent once the environment is ready.
- Sending to a paused Scaffold thread shows loading only on that thread/send control, not as an application-wide blocking state.
- Sending while an agent is active steers or interrupts by default according to OMP semantics.
- Reasoning and intermediate events stream as they occur. When a turn completes, reasoning and tool activity collapse into one Thinking section between the user prompt and final answer.
- Individual tool calls are collapsed by default; activity summaries remain visible.
- Subagent cards display task, status, model, and effort.
- Model and effort selectors live in the composer and display session-authoritative state, never a local fallback while a remote environment is disconnected.
- `@` supports explicit skills and compatible existing agent-session references. The OMP harness owns the semantics of messaging another agent or reading its worktree.
- Attachments support files and images.
- Selecting assistant output preserves native browser selection. The selection affordance offers Copy and Annotate; normal keyboard copy keeps working. An annotation is next-turn session context, not a durable review comment.
- Annotation confirmation accepts Enter; multiline entry uses the platform-standard modified Enter behavior.
- Terminal access remains a separate attach tab.

### Persistence, reconnect, and retention

- OMP continuation data is the authoritative provider/harness state.
- T3 SQLite is the authoritative product/read projection for messages, activities, approvals, thread metadata, and cached rendering.
- The OMP bridge assigns stable event IDs and a monotonic cursor. Replaying an event into T3 must be idempotent.
- A browser caches environment catalog, shell state, settled thread snapshots, usage snapshots, and pending sends in IndexedDB. IndexedDB is a browser-provided local database; users install or configure nothing.
- Navigating to a paused Scaffold thread renders the latest local snapshot without resuming the sandbox.
- Sending a message invokes `ensureRunning`, refreshes direct connection authority if needed, reconnects, reconciles event cursors, then drains the outbox exactly once.
- A cold browser with no cached snapshot cannot display a paused sandbox's full history until the sandbox resumes. Shared cloud history remains deferred.
- Done is not delete. A done Scaffold sandbox is paused for a defined retention period.
- Before eventual sandbox deletion, persist a compact, encrypted thread/handoff archive to Scaffold object storage. An old thread can restore into a new sandbox.

### Session-fabric compatibility invariants

The first release does not add a central multiplayer/session-fabric service, but its boundaries must remain attachable without changing turn ownership:

- The cross-thread compatibility contract is the section `Contract tests to land with the current harness work` in `/Users/czhen/.codex/worktrees/0c30/ashler-platform/.omx/plans/ashler-multiplayer-session-fabric.md`. This fork must keep those tests green as the cloud fabric is implemented independently.

- Every normalized provider event has a canonical event ID, a stable global session identity, and an environment-scoped monotonic source cursor. Resume/replay uses that cursor and rejects gaps or out-of-order delivery instead of relying on browser arrival order.
- T3 commits the event to its server-side orchestration log/projection before acknowledging the provider cursor. A post-commit server event-sink seam may publish the committed envelope to future fabric consumers. Browser IndexedDB is only a cache and outbox; it is never the sole conversation-history source.
- Send, steer, and interrupt commands carry stable command IDs and use the server command-receipt ledger. Retries return the recorded outcome and never execute the same command twice.
- `sessionId`, `environmentId`, and `runnerId` are durable, explicit identities. A restart may advance a runner epoch, but it must not silently mint a different logical session or environment.
- The selected environment remains the execution owner for worktrees, OMP state, tools, provider calls, and agent turns. A future central service may discover sessions, subscribe to committed events, and durably queue commands for an environment; it must not execute or proxy agent turns.
- Any future sink or command queue is asynchronous and failure-isolated after local durability. Its outage cannot prevent a local projection commit or make an already committed turn appear failed.

## Current upstream architecture and reuse

The implementation must preserve and extend these upstream systems instead of replacing them:

| Capability | Upstream source | Ashler use |
| --- | --- | --- |
| Provider SPI | `apps/server/src/provider/ProviderDriver.ts` | Add OMP as one driver/instance. |
| Provider operations | `apps/server/src/provider/Services/ProviderAdapter.ts` | Implement start, send, interrupt, requests, snapshots, rollback, stop, and canonical events. |
| Driver registration | `apps/server/src/provider/builtInDrivers.ts` | Small core patch to register OMP and apply an Ashler runtime profile. |
| Canonical event schema | `packages/contracts/src/providerRuntime.ts` | Reuse first; extend only after an event-conformance spike proves a real gap. |
| Orchestration projection | `apps/server/src/orchestration` and `apps/server/src/persistence` | Durable product state and idempotent command receipts. |
| Environment connection | `packages/client-runtime/src/connection` | Direct bearer target plus a managed lifecycle preparation hook. |
| Browser persistence | `apps/web/src/connection/storage.ts` | Reuse IndexedDB snapshots; add lifecycle metadata, usage cache, and pending-send outbox. |
| Reconnect supervision | `packages/client-runtime/src/connection/supervisor.ts` | Resume/retry after Scaffold readiness without global UI blocking. |
| Thread/worktree UX | `apps/web/src/composerDraftStore.ts`, `apps/web/src/hooks/useHandleNewThread.ts`, `apps/server/src/git` | T3 owns provisional drafts and local worktrees. |
| Settled/unread state | `packages/client-runtime/src/state/threadSettled.ts`, `apps/web/src/uiStateStore.ts`, `apps/web/src/components/SidebarV2.tsx` | Reuse grouping and attention semantics; attach Scaffold pause policy. |
| Command palette | `apps/web/src/components/CommandPalette.tsx` | Add harness, account, usage, and lifecycle-aware actions using existing design. |
| Desktop shell | `apps/desktop/src` | Rebrand, package, open OAuth browser, receive deep links, and host local backend. |
| Observability | `apps/server/src/observability`, `apps/web/src/observability`, `apps/desktop/src/app/DesktopObservability.ts` | Extend OTel correlation and redaction. |
| Upstream analytics | `apps/server/src/telemetry/AnalyticsService.ts` | Disable upstream PostHog by default before any Ashler distribution. |

## Proposed Ashler source layout

Keep protocol-neutral code in packages and server-specific driver code beside the upstream SPI. This avoids making a workspace package import private types from `apps/server`.

```text
packages/
  ashler-omp/
    src/contracts.ts
    src/eventNormalizer.ts
    src/continuation.ts
    src/accountClient.ts
    src/conformance.ts

  ashler-scaffold/
    src/controlPlaneClient.ts
    src/lifecycle.ts
    src/environmentMetadata.ts
    src/handoff.ts

  ashler-observability/
    src/attributes.ts
    src/redaction.ts
    src/traceContext.ts

apps/server/src/ashler/
  runtimeProfile.ts
  omp/OmpDriver.ts
  omp/OmpAdapter.ts
  omp/OmpProcess.ts
  omp/OmpAccountService.ts
  omp/OmpEventBridge.ts
  scaffold/ScaffoldBrokerAuthority.ts
  handoff/ThreadArchiveService.ts

apps/web/src/features/ashler/
  accounts/
  scaffold/
  sessionCreation/
  transcriptAnnotations/
  usage/

apps/desktop/src/ashler/
  identity/
  oauth/
  scaffold/
```

The exact package split can be consolidated if a package has only one consumer. The architectural rule is more important than the directory count: pure schemas/normalizers/clients may be packages; server SPI implementations stay in the server.

## Bounded upstream-core patch budget

The fork must maintain a checked list of upstream-owned files that Ashler intentionally changes. The initial expected list is:

| Core area | Likely files | Reason a pure overlay is insufficient | Containment rule |
| --- | --- | --- | --- |
| Provider registration | `apps/server/src/provider/builtInDrivers.ts`, `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts`, `apps/server/src/server.ts` | Drivers, default-instance hydration, and required Effect layers are composed statically. | Import one Ashler registry/profile and one Ashler layer bundle. `ProviderDriverKind` is already an open branded slug, so no contract edit is expected for `omp`. |
| Connection preparation | `packages/client-runtime/src/connection/model.ts`, `resolver.ts`, `layer.ts` | Target union and resolver switch are closed. | Phase 1 may store Scaffold metadata beside an existing bearer target; add a generic preparation registry only if needed. |
| Web composition | `apps/web/src/routes/__root.tsx`, `apps/web/src/components/CommandPalette.tsx`, session/sidebar composition files | Upstream has no general feature-contribution API. | Mount small Ashler feature entry points; keep feature implementation elsewhere. |
| Desktop composition | `apps/desktop/src/app`, `preload.ts`, IPC methods, build scripts | App identity, OAuth callback, URLs, and packaging are product-specific. | Centralize product identity and Ashler IPC additions behind one config module. |
| Telemetry defaults | `apps/server/src/telemetry/AnalyticsService.ts`, observability config | Upstream PostHog is enabled with upstream identity/config and OTLP custom auth is incomplete. | Default PostHog off; make Ashler OTLP explicit and redacted. |
| Branding/release | package metadata, icons, schemes, artifact/update scripts | Distribution cannot be changed at build time without touching static metadata. | Generate from one Ashler product manifest where possible. |

Before each upstream sync, compare the actual fork delta to this table. New core-file edits require an explicit design note and a failed additive alternative. Favor upstreaming generic seams such as a provider registry extension, managed-environment preparation hook, and product manifest, but do not depend on upstream accepting them.

## Data contracts

The names below are planning contracts, not a requirement to put every field in `packages/contracts`.

```ts
type HarnessKind = "omp" | "codex" | "claude-code";
type EnvironmentKind = "local" | "scaffold";

type AshlerRuntimeProfile = {
  environmentKind: EnvironmentKind;
  allowedHarnesses: readonly HarnessKind[];
  defaultHarness: HarnessKind;
  scaffoldTarget?: "staging" | "production";
};

type ScaffoldEnvironmentBinding = {
  provisionalThreadId: string;
  scaffoldSessionId: string;
  sandboxId: string;
  lifecycleEpoch: number;
  lifecycle: "creating" | "running" | "pausing" | "paused" | "failed" | "deleted";
  directEnvironmentId?: string;
  directEndpoint?: string;
  connectionId?: string;
  links: { session: string; web: string; tilt: string };
  lastKnownAt: string;
};

type OmpSessionBinding = {
  t3ThreadId: string;
  ompSessionId: string;
  continuationVersion: number;
  lastProjectedCursor: string | null;
  primaryModel: string;
  effort: string;
  advisorModel?: string;
  assignedAccount?: { provider: string; maskedLabel: string; assignmentId: string };
};

type PendingTurn = {
  idempotencyKey: string;
  threadId: string;
  environmentId: string;
  createdAt: string;
  prompt: string;
  attachments: readonly AttachmentReference[];
  annotations: readonly TranscriptAnnotation[];
  requestedModel: string;
  requestedEffort: string;
  state: "queued" | "preparing" | "sending" | "acknowledged" | "failed";
};

type HandoffEnvelope = {
  version: number;
  source: { environment: EnvironmentKind; harness: HarnessKind; threadId: string };
  destination: { environment: "scaffold"; harness: "omp" };
  transferMode: "exact-omp" | "contextual-cross-harness";
  repository: { remote: string; baseSha: string; prBase?: string };
  workspaceArchive: { digest: string; objectKey: string };
  attachmentManifest: readonly AttachmentReference[];
  transcriptArchive: { digest: string; objectKey: string };
  ompContinuation?: { digest: string; objectKey: string; sessionId: string };
  secretScan: { result: "clear" | "overridden"; auditId?: string };
};
```

Credentials, raw account IDs, and provider tokens must not appear in these persisted client-visible contracts.

## Key flows

### Local OMP thread

1. User chooses Local + OMP, repository, model, and effort.
2. UI creates a provisional draft and returns to the main surface immediately.
3. T3 creates a worktree from the selected repository `HEAD` and records its base/branch/path.
4. If a prompt is already queued, T3 starts the OMP adapter in that `cwd` and drains the outbox.
5. OMP assigns one eligible account and persists the assignment with the continuation.
6. OMP emits events; the bridge maps them to stable T3 canonical events and advances the cursor only after projection acknowledgement.

### Local native Codex or Claude Code thread

1. User explicitly chooses the native harness at creation.
2. T3 creates the worktree and launches its existing provider adapter in that `cwd`.
3. The native CLI owns auth and provider continuation.
4. Ashler account-pool UI does not claim that OMP accounts affect this thread.

### Scaffold thread create/send

1. UI creates a provisional local binding and stores the first turn in IndexedDB.
2. The Scaffold lifecycle client creates a staging or production sandbox according to validated runtime configuration.
3. The sandbox boots the Ashler T3 server and OMP, then reports readiness with the expected environment/thread binding.
4. The control plane returns a direct endpoint plus short-lived bootstrap authority.
5. The client registers an ordinary T3 bearer connection target and stores Scaffold lifecycle metadata separately.
6. The connection supervisor connects directly to the sandbox.
7. The outbox sends the turn once with its idempotency key.
8. Later direct traffic bypasses the lifecycle service.

The create operation must distinguish `sandbox process healthy but acknowledgement timed out` from a real failed sandbox. Readiness is reconciled by stable operation ID and lifecycle epoch rather than marking the session permanently failed on a single client timeout.

### Paused Scaffold thread

1. Selection renders the latest IndexedDB snapshot without lifecycle mutation.
2. A send changes only that row/composer to Resuming and stores the pending turn.
3. `ensureRunning(binding, expectedEpoch)` is idempotent. `409 lifecycle changed` triggers a state refresh and is success if the desired state already holds.
4. Once ready, refresh the direct credential, reconnect, reconcile OMP/T3 cursor state, and drain the outbox once.
5. Navigation and creation elsewhere remain usable throughout.

### Done/settle

1. Mark the T3 thread settled locally and optimistically move it to Done.
2. For Scaffold, request pause with the current lifecycle epoch.
3. Treat `already paused/stopped` and a `409` whose refreshed state is paused/stopped as success.
4. On a genuine failure, preserve Done and show a retryable lifecycle warning rather than `[object Object]`.
5. A new send reopens the thread and calls `ensureRunning`.

### Handoff to Scaffold

- OMP local to OMP Scaffold is an exact continuation transfer: worktree delta, attachments, T3 transcript projection, OMP continuation/session record, and cursor metadata.
- Native Codex/Claude to OMP Scaffold is contextual: worktree delta, attachments, normalized transcript/summary, pending annotations, and explicit source-harness metadata. It does not claim to preserve a native provider continuation.
- Exclude `.git`, dependency caches, build outputs, and detected credentials.
- Secret findings block before any remote creation or upload. Override requires a nonempty reason and produces an audit record.
- The destination publishes success only after OMP confirms the migrated session ID and T3 has imported or reconstructed the matching projection.

### Crash/reconnect/replay

1. T3 reconnects to OMP using the stored continuation identity and last acknowledged cursor.
2. OMP replays events after that cursor with stable event IDs.
3. T3 idempotently ignores already projected events and detects gaps/out-of-order events.
4. If OMP continuation is ahead of T3, rebuild the missing projection.
5. If T3 is ahead of a missing/corrupt continuation, mark the harness binding degraded and offer an explicit contextual recovery; never silently invent provider state.

## OMP event-conformance gate

Before broad UI work, build a recorded-stream conformance suite covering:

- assistant text start/delta/end;
- reasoning start/delta/end and long periods without text;
- command/tool start, progress, output, completion, and failure;
- file changes and persisted-file events;
- main-agent and nested subagent lifecycle, including model and effort;
- plan updates;
- approvals and structured questions;
- user steering, interruption, and aborted turns;
- model/effort changes and model reroutes;
- account assignment, usage, quota, hard exhaustion, and one-time reassignment;
- attachments and transcript annotations;
- provider errors, retryable transport errors, and terminal failures;
- reconnect/replay, duplicate delivery, gap detection, and process restart.

The first implementation should target the existing `ProviderRuntimeEventV2` union. Changes to `packages/contracts/src/providerRuntime.ts` are allowed only when a required OMP concept cannot be represented without loss and a UI consumer needs the distinction.

## Auth and security

### Local

- OMP local login begins from the server/desktop and opens the system browser.
- The callback completes through a loopback endpoint or Ashler desktop URL scheme.
- Tokens are stored by the local OMP account service in OS-backed secure storage where available; browser IndexedDB stores labels/usage only.
- Direct native Codex/Claude login remains delegated to the official CLI flows.
- Account add/remove is independent from thread lifecycle.

### Scaffold

- The sandbox authenticates to the central broker using workload identity or a narrowly scoped, short-lived sandbox credential.
- The broker owns subscription credentials and provider-specific request behavior.
- The sandbox receives a request-scoped provider response stream, not reusable OAuth refresh tokens.
- Direct browser-to-sandbox authority is separate from sandbox-to-provider authority.
- Endpoint/bootstrap credentials are short lived, environment-bound, and renewable without changing the stored thread model.
- CORS and WebSocket origins are explicit for local web, Ashler desktop, and approved Scaffold domains.

### Required threat tests

- no provider or Scaffold credentials in client RPC payloads, IndexedDB, logs, traces, exports, or error toasts;
- no cross-user environment/token use;
- no replay of expired bootstrap credentials;
- no handoff upload after secret scan failure;
- no coordinator proxy after direct connection is established;
- broker requests bound to the expected sandbox, user, provider, and assigned account;
- lifecycle epoch prevents stale pause/resume/delete actions from winning races.

## Observability and privacy

Use T3's existing OpenTelemetry traces/metrics and add one trace context across:

```text
client interaction -> T3 RPC -> Scaffold lifecycle (if needed) -> OMP turn
  -> account assignment -> provider/model request -> tool/subagent -> render/final
```

Required measurements include:

- send-to-ack, send-to-first-reasoning, send-to-first-text, and render lag;
- worktree create time and failure category;
- Scaffold create/resume/readiness/direct-connect latency and lifecycle result;
- OMP queue, model request, tool, subagent, interrupt, and total turn time;
- account-pool eligibility, assignment pressure, throttling, usage refresh age/failure;
- reconnect count, cache source/age, replay size, duplicate/gap count;
- handoff scan/archive/upload/restore time and result;
- active/settled/unread/awaiting-input counts without raw thread IDs.

Never include prompt text, model output, source code, file paths, tool arguments, OAuth tokens, full account identifiers, sandbox IDs, thread IDs, or repository URLs in metrics. Traces use redacted or keyed-hash identifiers only when correlation is required.

Upstream PostHog must be disabled by default before the first Ashler build. If product analytics are later enabled, they use Ashler-controlled configuration, explicit data classification, and the same redaction rules. OTLP exporters need an authenticated-header configuration path suitable for the Ashler collector.

## Implementation phases

### Phase 0: Fork baseline and maintenance guardrails

Tasks:

1. Preserve the MIT license and generate third-party notices for distributions.
2. Add `upstream` remote and record the base SHA in release metadata.
3. Create one Ashler product manifest for name, bundle IDs, URL schemes, domains, update feed, telemetry defaults, and runtime profile.
4. Disable upstream PostHog by default.
5. Add a script/check that reports Ashler edits outside additive directories and the core patch allowlist.
6. Establish scheduled, reviewed upstream syncs pinned to stable tags or selected SHAs rather than every nightly.
7. Capture baseline web/server/desktop smoke tests before behavior changes.

Exit criteria:

- Ashler web and macOS development builds launch from the fork.
- No event is sent to upstream telemetry.
- The release artifact records its upstream base SHA and Ashler version.
- Fork-delta report is clean against the initial allowlist.

### Phase 1: Local OMP vertical slice

Tasks:

1. Implement OMP process/session transport and `OmpDriver`.
2. Implement the full `ProviderAdapterShape` surface or explicitly mark unsupported operations.
3. Build the recorded event-conformance suite before custom transcript rendering.
4. Register OMP and its required Effect layers.
5. Add OMP model/effort selection to new-thread creation and the composer.
6. Prove streaming reasoning, text, tools, subagents, steering, interrupt, approvals/questions, and replay.
7. Run OMP inside a T3-created worktree and show PR-base changes in the existing review UI.

Exit criteria:

- A local browser creates an OMP worktree thread without modal blocking.
- ChatGPT and Claude subscription calls complete through OMP and consume the selected account's included plan allowance.
- One approved Bifrost model completes a turn.
- Refresh/restart restores the exact thread and does not duplicate content or a pending turn.
- Native Codex and Claude threads still work locally.

### Phase 2: Accounts, usage, and local parity

Tasks:

1. Add OMP account service contracts and local secure storage.
2. Add ChatGPT/Claude login, removal, masked account display, eligibility, and cached usage.
3. Implement sticky per-session assignment and cross-session balancing.
4. Implement hard-exhaustion classification and one permitted reassignment.
5. Add Command-K account/usage commands and lazy refresh.
6. Complete parity audit for attachments, annotations, `@` skills/sessions, notifications, compact sidebar, Done grouping, collapsed thinking/tools, and subagent metadata.
7. Reuse T3 behavior when present; add Ashler UI only for gaps.

Exit criteria:

- Multiple accounts distribute across new sessions but never switch between ordinary turns.
- Usage appears without opening a particular thread and survives refresh/offline state.
- Usage refresh errors are nonfatal.
- Selection can be copied or annotated with keyboard behavior intact.
- A question/awaiting-input state triggers T3's existing sound and desktop notification.

### Phase 3: Scaffold managed environment

Tasks:

1. Add typed Scaffold lifecycle client with validated staging/production target configuration.
2. Build an Ashler sandbox image containing T3 server + OMP only.
3. Add provisional Scaffold thread/environment records and per-thread preparation state.
4. Create/resume via the control plane; connect through direct bearer endpoint afterward.
5. Add IndexedDB lifecycle binding and pending-turn outbox.
6. Add direct Session/Web/Tilt links and compact Scaffold sidebar row.
7. Implement idempotent Done/pause and send/resume race reconciliation.
8. Add central broker workload auth and OpenAI/Anthropic request routing.
9. Validate local browser UI attachment to both a local environment and multiple staging Scaffold environments.
10. Validate the sandbox-hosted UI shows only its own environment/thread.

Exit criteria:

- Scaffold create, first send, pause, cached navigation, resume/send, steer, and Done all pass on staging.
- Navigation and other session creation remain responsive during create/resume.
- A 409 lifecycle race converges to the desired state instead of surfacing a false failure.
- Browser-to-sandbox agent traffic is direct; the lifecycle service carries no transcript/tool/file stream.
- A network drop recovers without losing or duplicating a queued turn or reverting the selected model.

### Phase 4: Handoff and retention

Tasks:

1. Define/version the handoff envelope and archive manifest.
2. Integrate the existing Ashler workspace/OMP continuation transfer with T3 projection import.
3. Add contextual native-harness-to-OMP handoff.
4. Preserve attachments, annotations, PR base, account-independent model intent, and integrity metadata.
5. Keep secret scanning fail-closed with audited override.
6. Archive done sessions to object storage before retention deletion.
7. Restore an archived session into a new sandbox with a new direct endpoint.

Exit criteria:

- Local OMP to Scaffold resumes the same OMP session identity and worktree state.
- Native Codex/Claude handoff is explicitly labeled contextual and retains workspace plus readable context.
- Failed scan creates no remote session/upload and cleans temporary archives.
- Restore after original sandbox deletion produces the expected transcript and workspace.

### Phase 5: Native distribution and production hardening

Tasks:

1. Complete Ashler desktop identity, macOS signing/notarization, URL scheme, updates, and diagnostics.
2. Add desktop OAuth callback and secure-store integration.
3. Configure authenticated OTLP export and dashboards/SLOs.
4. Load/cold-start test T3 + OMP sandbox resource usage.
5. Security review broker, direct endpoint authorization, handoff, and telemetry.
6. Define rollback-compatible release channels and server/client version compatibility.

Exit criteria:

- Signed macOS build runs local OMP/native sessions and attaches to staging Scaffold.
- Staging SLOs and alerting cover create/resume/connect/turn/handoff paths.
- No secrets or user content appear in default telemetry or diagnostics export.

### Phase 6: Parity, soak, and cutover

Tasks:

1. Run the same local and staging scenario suite against the existing UI and T3 fork.
2. Soak reconnect, account balancing, paused sessions, and concurrent clients.
3. Document any intentional behavior differences.
4. Migrate only active development users; existing OpenCode conversations do not require import.
5. Keep the existing UI available for rollback through the first stable Ashler T3 release.

Exit criteria:

- Required scenarios pass for local web, macOS desktop, local-to-Scaffold attachment, and sandbox-hosted UI.
- No P0/P1 correctness, auth, lifecycle, replay, or data-loss defect remains.
- The existing UI can be retired only after an explicit cutover decision.

## Test matrix

Minimum automated coverage:

| Layer | Required tests |
| --- | --- |
| OMP normalizer | Golden recorded streams, duplicates, gaps, nested subagents, errors, account reroute. |
| Provider adapter | Start/send/interrupt/request/stop/read/rollback/restart and resource cleanup. |
| Orchestration | Stable global session/environment/runner identity; canonical event IDs and resumable source cursors; projection idempotency; post-commit sink ordering; duplicate command IDs return the original receipt/sequence without repeating send, steer, or interrupt effects. |
| OMP fixtures | Deterministic reasoning, tool lifecycle, requested user input, assistant output, runtime error, and terminal/tool-execution fixtures with stable event IDs and replay order. |
| Client source seam | An injectable session-directory/transcript source proves that a future Relay can become authoritative without treating IndexedDB or a direct environment connection as the only history source. |
| Worktrees | Concurrent creation, dirty source checkout, cancellation, cleanup, PR-base diff. |
| Account pool | Eligibility, sticky assignment, weighted balancing, stale usage, hard exhaustion, revoked auth. |
| Scaffold lifecycle | Create timeout reconciliation, resume/pause races, 409 desired-state convergence, auth renewal. |
| Connection | Direct bearer routing, reconnect/backoff, cached history, cold client, model-state authority. |
| Handoff | Exact/contextual modes, secret gate, integrity, replay, partial failure cleanup, restore. |
| Web UX | Provisional navigation, per-row loading, sidebar stability, Cmd-K, copy/annotate, collapse behavior. |
| Desktop | System browser/deep link, secure storage, notifications, backend launch, update/signing smoke. |
| Observability | Trace propagation, cardinality bounds, redaction, telemetry disabled defaults. |

Staging end-to-end scenarios:

1. Create two Scaffold sessions concurrently and continue using a local thread while both boot.
2. Send before readiness, navigate away, refresh, and verify exactly one delivered turn.
3. Pause, view cached history, resume by sending, disconnect mid-turn, and recover stream/model state.
4. Mark Done during a lifecycle race and verify pause convergence.
5. Run simultaneous ChatGPT and Claude OMP sessions and verify sticky account attribution/usage.
6. Handoff a local OMP worktree and a native Claude worktree to separate sandboxes.
7. Open the same sandbox from local web and its direct Scaffold view and verify consistent server state.
8. Attach a test post-commit sink, restart the runner mid-turn, and verify the sink observes the same canonical event IDs/order while the environment retains execution ownership and duplicate send/steer/interrupt commands are receipt-deduplicated.

## Uncertainties and required spikes

These are implementation questions, not reasons to delay the fork baseline.

1. **OMP event fidelity.** Confirm every OMP event can map to `ProviderRuntimeEventV2` without losing ordering or interaction semantics. Exit: golden traces cover the conformance matrix and list any justified contract additions.
2. **Dual durability.** Define the exact acknowledgement boundary between OMP continuation and T3 projection. Exit: forced crashes at each boundary recover without duplication or silent loss.
3. **Managed connection seam.** Decide whether lifecycle preparation remains metadata beside `BearerConnectionTarget` or warrants a generic connection-preparation registry. Exit: first staging vertical slice plus measured core-diff cost.
4. **Subscription auth policy.** Validate ChatGPT and Claude subscription OAuth/client compatibility, central broker behavior, refresh handling, and provider terms. Exit: written security/policy approval and staging calls charged to included allowance.
5. **Usage accuracy.** Establish authoritative quota endpoints, refresh cadence, normalization, and semantics for unavailable models versus disconnected accounts. Exit: UI snapshots reconcile with official client displays within documented tolerances.
6. **Local Bifrost authority.** Confirm whether local OMP may call Ashler's central Bifrost gateway directly and how it authenticates. Exit: one approved model call with scoped local credentials and usage attribution.
7. **Handoff semantics.** Confirm exact OMP continuation portability and how T3 imports full interaction state. Exit: checksum-stable round trip for OMP; documented/context-labeled native conversion.
8. **Transcript selection annotations.** T3 has file/preview annotation concepts; verify whether assistant-output selection already has the required copy/annotate behavior. Exit: parity test or a bounded Ashler feature design.
9. **Resource footprint.** Measure T3 server + OMP image size, memory, process count, boot time, and E2B/Nomad capacity implications. Exit: staging load test meets agreed sandbox density and cold-start SLO.
10. **Retention.** Choose pause period, archive format/storage class, deletion policy, restore SLA, and user-visible status. Exit: approved lifecycle policy plus restore test.
11. **Upstream churn.** Quantify monthly conflicts in the core patch allowlist. Exit: two successful upstream sync drills and a conflict budget.
12. **Cross-version compatibility.** Decide how web/desktop clients negotiate with older sandbox server images. Exit: version matrix and clear upgrade/block behavior.

## Explicitly deferred

- A global hosted Scaffold page backed by one shared Durable Object across all sandboxes.
- Routing all sandbox traffic through a coordinator pod.
- Importing old OpenCode conversations.
- Exact continuation from native Codex or Claude into OMP.
- Shipping native Codex or Claude Code in Scaffold images.
- Mobile app release; preserve upstream architecture but target web and macOS first.
- Durable collaborative transcript review comments; transcript annotations are next-turn context only.
- Automatic deletion of Done sessions before archive/restore policy is implemented.

## Fork sync and release discipline

- `upstream/main` remains a fetch-only view of T3 Code.
- `origin/main` is the releasable Ashler distribution branch once the implementation begins.
- Feature work uses ordinary short-lived branches and reviewed merges.
- Sync upstream on a scheduled cadence from a reviewed stable tag or pinned SHA.
- Every sync PR contains:
  - old/new upstream SHA;
  - upstream changelog summary;
  - fork-delta allowlist report;
  - provider/event/connection/desktop conflict assessment;
  - focused conformance, web, server, and desktop smoke results.
- Every Ashler release records upstream SHA, Ashler commit, sandbox image version, OMP version, supported client/server range, and rollback target.
- Do not vendor T3 source at Ashler build time. The product fork is the reviewable source of truth, and `upstream` remains available for direct comparison and synchronization.

## Definition of success

The fork is ready to replace the original UI when a user can:

1. launch the Ashler web or macOS client;
2. create a nonblocking local OMP worktree session or a provisional Scaffold session;
3. use connected ChatGPT/Claude accounts and approved Bifrost models with accurate cached usage;
4. see live reasoning, tools, subagents, status, notifications, attachments, annotations, and PR-base changes;
5. steer, interrupt, change model/effort, settle, resume, reconnect, and recover without state loss;
6. hand a local workspace/session to Scaffold and connect directly to that sandbox;
7. run native Codex or Claude Code locally when explicitly selected;
8. observe the system end to end without leaking user content or credentials.

Until all eight are demonstrated in automated and staging tests, the existing Ashler OMP UI remains available and running as the fallback implementation.
