# Session fabric proof Worker

This package deploys only the public session-fabric API, its per-session
`SessionStreamCoordinator` Durable Objects, and the public `SessionDirectory`
Durable Object. It does not deploy the T3 Connect Relay or require its
PlanetScale, Clerk, APNs, Axiom, or DNS credentials.

The manual `Deploy session fabric proof` workflow uses the protected
`session-fabric-proof` environment and accepts the isolated Worker's Cloudflare
and embedding values:

- `CLOUDFLARE_ACCOUNT_ID` as an environment variable.
- `CLOUDFLARE_API_TOKEN` as an environment secret.
- `BASETEN_EMBEDDING_URL` as an environment variable.
- `BASETEN_API_KEY` as an environment secret.

The Baseten bindings are required for the zero-lexical-overlap semantic search
proof. Without them, the Worker deliberately falls back to lexical ranking.

The deploy uses Cloudflare-backed Alchemy state so later deploys and the
explicit destroy operation share one authoritative resource history. The
Worker has the stable name `ashler-session-fabric-proof` and uses its
`workers.dev` URL; no DNS mutation is required.

After deployment, configure a proof T3 runner with the workflow's `relay_url`
output as `T3CODE_SESSION_FABRIC_RELAY_URL`. Run the live acceptance check with:

```sh
pnpm --dir infra/session-fabric smoke:scaffold \
  --relay-url "$T3CODE_SESSION_FABRIC_RELAY_URL" \
  --session-id "$T3CODE_SESSION_FABRIC_SESSION_ID" \
  --semantic-query "coordinated interfaces transferred a programming artifact" \
  --message "Return the requested proof marker and modify a tracked file."
```

The semantic query must share no normalized tokens with the target session's
searchable transcript. A positive target score therefore proves that the
deployed directory used embeddings rather than its lexical fallback.

Rollback is the same workflow with `operation=destroy`. Destroying the stack
also deletes its Durable Object data, so capture any required proof evidence
first.
