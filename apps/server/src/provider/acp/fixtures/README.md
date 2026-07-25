# OMP ACP compatibility fixture

`omp-acp-harness-fixture.ts` locks the OMP adapter's supported ACP surface to a
deterministic sequence: reasoning, execute-kind tool lifecycle, structured user
input, assistant output, prompt failure, replay, and terminal session/turn
events.

ACP terminal creation and terminal output streaming are not part of the current
OMP harness compatibility surface. Command execution is represented through
`tool_call` / `tool_call_update` events with `kind: "execute"`, including the
command in `rawInput` and exit status/stdout/stderr in `rawOutput`. The fixture
must not be extended to imply cloud-fabric or provider terminal support.
