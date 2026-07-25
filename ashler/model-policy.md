# OMP model policy

`model-policy.json` is enforced by the T3 server after OMP reports its live ACP
model catalog. The browser receives only the intersection of that catalog and
this policy. A policy entry never creates an available model by itself.

OMP is the default Ashler harness. A new project or auto-bootstrapped thread is
assigned to the default `omp` instance only after its live catalog reports an
allowed model. `openai-codex/gpt-5.6-sol` is preferred; another live allowed OMP
model is used when Sol is unavailable. Ashler does not persist a fabricated
model selector while discovery is pending or failed. Native Codex, Claude,
Cursor, Grok, and OpenCode drivers remain available in local installations.
Managed Scaffold images expose only OMP.

## Managed Bifrost overlay

The T3 server can add the `ashler` provider to an isolated OMP `models.yml`.
This path is enabled only when all of the following are present:

- `ASHLER_OMP_AGENT_DIR` (or the OMP provider's explicit `agentDir` setting):
  absolute managed agent directory where `models.yml` is merged;
- `LLM_GATEWAY_URL`: HTTPS gateway origin (loopback HTTP is accepted for tests);
- `LLM_GATEWAY_API_KEY`: Bifrost virtual key, supplied as a sensitive provider
  environment variable or managed process secret;
- `SCAFFOLD_SESSION_ID`: optional attribution dimension.

The generated file references `LLM_GATEWAY_API_KEY` by name in `apiKey` and
header fields and is written mode `0600`; the credential value is never written
to disk or returned to the browser. Existing providers in the managed
`models.yml` are preserved. T3 deliberately refuses to write into the implicit
user `~/.omp/agent` directory.

The gateway contract must accept the canonical model IDs
`moonshotai/Kimi-K2.6` and `x-ai/grok-4.5`. If the platform Bifrost deployment
still requires `baseten/moonshotai/Kimi-K2.6` on the wire, its managed OMP image
must provide that request-model mapping; T3 keeps the user-facing/catalog ID
canonical and does not expose the backend route.

The Ashler OMP ACP extension exposes a session-scoped `advisor` select config
option whose values are `off` or a model selector such as
`anthropic/claude-sonnet-5:high`. Its `session/set_config_option` handler:

1. validate the selector against the session's live model registry;
2. apply it to the session's `modelRoles.advisor` runtime override; and
3. enable or disable the session advisor runtime immediately.

T3 resolves the cross-provider default from this policy and applies it through
that option only after OMP reports the target model in the live session catalog.
The selected advisor is session-authoritative and persists until the user
changes it again.
