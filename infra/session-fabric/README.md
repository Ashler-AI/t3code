# Session fabric proof Worker

This package deploys only the public session-fabric API, its per-session
`SessionStreamCoordinator` Durable Objects, and the public `SessionDirectory`
Durable Object. It does not deploy the T3 Connect Relay or require its
PlanetScale, Clerk, APNs, Axiom, or DNS credentials.

The manual `Deploy session fabric proof` workflow uses the protected
`session-fabric-proof` environment and accepts two Cloudflare values:

- `CLOUDFLARE_ACCOUNT_ID` as an environment variable.
- `CLOUDFLARE_API_TOKEN` as an environment secret.

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
  --message "Return the requested proof marker and modify a tracked file."
```

Rollback is the same workflow with `operation=destroy`. Destroying the stack
also deletes its Durable Object data, so capture any required proof evidence
first.
