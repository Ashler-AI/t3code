# Session fabric proof Worker

This package deploys only the public session-fabric API, its per-session
`SessionStreamCoordinator` Durable Objects, and the public `SessionDirectory`
Durable Object. It does not deploy the T3 Connect Relay or require its
PlanetScale, Clerk, APNs, Axiom, or DNS credentials.

The Scaffold staging candidate workflow in `Ashler-AI/ashler-platform` is the
sole CI deployment owner for the shared `ashler-session-fabric-proof` Worker.
This repository intentionally contains no mutating deployment workflow. The
package scripts and validation helpers remain here because the Platform
controller checks out an exact T3 commit and invokes them with its protected
Scaffold staging Cloudflare and embedding values:

- `CLOUDFLARE_ACCOUNT_ID` as an environment variable.
- `CLOUDFLARE_API_TOKEN` as an environment secret.
- `BASETEN_EMBEDDING_URL` as an environment variable.
- `BASETEN_API_KEY` as an environment secret.
- `SESSION_FABRIC_ALLOWED_ORIGINS` as a comma-separated environment variable
  containing the exact Scaffold web origins allowed to call the proof Worker.
- `SESSION_FABRIC_PROOF_SIGNING_PRIVATE_KEY` as a protected environment secret
  containing the persistent Ed25519 proof signing key.
- `SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON` as an optional environment
  variable containing verifier-only overlap keys during a planned rotation.

The Platform workflow always deploys the Worker with required capability auth. It uses
the dedicated proof issuer and audience declared in the workflow, derives a
stable key ID and public verifier from the protected signing key, and exposes
the private key only to the verifier-preparation step and its mode-`0600`
temporary file. Keeping the signer stable prevents a newly deployed outer
Worker and an older Durable Object isolate from disagreeing about the active
key. To rotate it, first deploy the new public key through
`SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON` while the old signer remains
active, then switch the signing secret while retaining the old public key for
one deployment, and remove the old verifier only after that deployment is
healthy.

The Baseten bindings are required for the zero-lexical-overlap semantic search
proof. Without them, the Worker deliberately falls back to lexical ranking.

The deploy uses Cloudflare-backed Alchemy state so later deploys share one
authoritative resource history. The
Worker has the stable name `ashler-session-fabric-proof` and uses its
`workers.dev` URL; no DNS mutation is required. CI uses the package-pinned
Wrangler to capture that fixed Worker's single active version before Alchemy
deploys. Scaffold staging has no bootstrap exception: a missing prior version
fails closed.

Do not run `pnpm --dir infra/session-fabric deploy` or `destroy` locally or from
another workflow against the shared proof Worker while Platform staging manages
it. Those scripts are controller building blocks, not a second deployment
surface. Use a differently named isolated stack for local experimentation.

The post-deploy smoke mints separate short-lived viewer and runner
capabilities. Before the behavioral smoke, an authenticated Durable Object
probe reads the guaranteed pre-existing `deployment-smoke-proof-v1` snapshot
and requires HTTP `200`. It retries bounded network errors, `401`, `429`, and
deployment-transient `5xx` responses under one deadline so an old isolate must
demonstrably accept the stable signer before deployment continues. A missing
snapshot fails closed. The readiness CLI has an explicit
`--allow-missing-bootstrap` escape hatch only for the first deployment of a
truly fresh isolated environment; the Scaffold staging workflow must never use
that flag. The smoke then proves that
anonymous directory and snapshot reads return `401`, an allowed Scaffold-origin
preflight returns `204`, the runner can publish a public Scaffold snapshot, and
the viewer can read the retained offline snapshot after the runner disconnects.

If capability minting, authenticated readiness, or behavioral smoke fails after deployment, CI
uses non-interactive `wrangler rollback` to restore the captured version of the
fixed Worker before removing the temporary signing-key file, then keeps the job
failed. A rollback failure remains the surfaced failure. Cloudflare rollback
restores Worker code and bindings by creating a new active deployment; it does
not roll back or delete Durable Object data. This workflow makes no Durable
Object class lifecycle changes because Cloudflare can reject rollback across
such changes. Immediately before rollback, CI re-reads the fixed Worker's active
version and requires it to match the candidate captured immediately after
Alchemy deploy. A mismatch fails closed instead of overwriting a newer external
deployment.

Every later Alchemy deployment uses `--force`. Wrangler rollback changes the
remote Worker without rewriting Alchemy's persisted resource output, so forcing
reconciliation prevents a retry of the same candidate from incorrectly no-oping
and validating the rolled-back Worker version.

After deployment, configure a proof T3 runner with the Platform workflow's `relay_url`
output as `T3CODE_SESSION_FABRIC_RELAY_URL`. The shared public-config loader
validates this HTTP(S) URL and projects it to
`VITE_T3CODE_SESSION_FABRIC_RELAY_URL` for web development and builds. Missing
or invalid values leave browser route bootstrap and composer session search
disabled. Run the live acceptance check with:

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

The package's `destroy` script is destructive cleanup, not deployment rollback,
and is not permitted against the Platform-managed shared Worker. Destroying an
isolated stack also deletes its Durable Object data, so capture any required
proof evidence first.
