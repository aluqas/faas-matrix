# Complement Wrapper Image

This repository includes a minimal Docker wrapper for running `faas-matrix` as a Complement homeserver image.

The wrapper is intentionally narrow:

- it runs `wrangler dev` in local mode
- it exposes `8008` for client-server traffic over HTTP
- it exposes `8448` for federation traffic over HTTPS
- it generates a `SERVER_NAME` certificate from Complement's mounted CA when available
- it runs the full local D1 migration set before starting the worker

This is meant for early Complement and out-of-repo CSAPI coverage. It is not a faithful reproduction of Cloudflare production runtime behavior.

## Files

- [`wrangler.complement.jsonc`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/wrangler.complement.jsonc)
- [`docker/complement/Dockerfile`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/docker/complement/Dockerfile)
- [`docker/complement/entrypoint.sh`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/docker/complement/entrypoint.sh)
- [`docker/complement/nginx.conf.template`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/docker/complement/nginx.conf.template)

## Build

```bash
docker build -f docker/complement/Dockerfile -t complement-faas-matrix .
```

## Complement Usage

For out-of-repo Complement tests:

```bash
COMPLEMENT_BASE_IMAGE=complement-faas-matrix go test -v ./tests
```

For local development inside this repository, prefer the wrapper scripts:

```bash
bun run complement:index
bun run complement:run -- TestAddAccountData
bun run complement:run -- --pkg ./tests/csapi TestAddAccountData
bun run complement:run -- --list-packages TestContentMediaV1
bun run complement:run:debug -- TestContentMediaV1
bun run complement:full
```

The wrapper expects Complement to provide:

- `SERVER_NAME`
- `/complement/ca/ca.crt`
- `/complement/ca/ca.key`

If the CA files are absent, the container falls back to a self-signed certificate so the image can still be started manually.

## Runtime Notes

- The entrypoint writes `.dev.vars` at container start so `SERVER_NAME` and the feature profile can be injected into `wrangler dev`.
- Complement runs now default to `MATRIX_FEATURE_PROFILE=complement`, propagated from the host via `COMPLEMENT_SHARE_ENV_PREFIX=FAASMATRIX_`.
- Local state is stored under `/data/wrangler`.
- The wrapper applies `migrations/schema.sql` and then the numbered files under `migrations/` on every start with `wrangler d1 execute --local`.
- The wrapper image uses Node.js to execute Wrangler even though the repository itself uses `bun`, because Wrangler's local runtime path is not supported under Bun.
- Optional integrations such as email, LiveKit VPC service, and Cloudflare remote-only bindings are intentionally left out of the Complement config.

## Runner Behavior

`scripts/complement-run.ts` is package-aware.

- Explicit test names auto-resolve to a single Go package using [`scripts/complement-test-index.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/scripts/complement-test-index.json).
- `--full` is the only mode that falls back to `./tests/...` by default.
- `--pkg` bypasses auto-resolution when a test name is ambiguous or when you want to run a whole package.
- `--startup-debug` enables:
  - `COMPLEMENT_SPAWN_HS_TIMEOUT_SECS=60` by default
  - `COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS=1`
  - `WRANGLER_LOG_LEVEL=info`
  - entrypoint phase logging for container startup
- non-`--full` targeted runs now default to `COMPLEMENT_SPAWN_HS_TIMEOUT_SECS=40` to reduce false negatives from slow local startup without making routine TDD too slow
- if a single bucket still needs a wider ceiling, pass `--spawn-timeout <seconds>` explicitly instead of raising the global default

Each run writes:

- raw test log: `logs/<ts>.log`
- docker sidecar log: `logs/<ts>.docker.log`
- machine summary: `logs/<ts>.summary.json`
- flake classification: `logs/<ts>.classified.json`

For startup profiling without running a full Complement package, use:

- `bun run complement:startup:preflight -- --iterations 3`
- `bun run complement:startup:preflight -- --iterations 3 --instances 2`

This runs the Complement image directly, polls `/_internal/ready`, and prints phase timings from the entrypoint JSON logs. By default it reuses `/data` across iterations so you can see whether cached startup state is actually helping.

The classifier separates:

- `implementation_fail`
- `startup_flake`
- `infra_flake`
- `mixed`

This is intended to keep targeted TDD runs usable even when full runs are noisy.

## Current Limits

- This validates the local `wrangler dev` execution surface, not Cloudflare's deployed runtime behavior.
- Complement out-of-repo currently supports CSAPI-oriented testing well, but mock federation servers are still internal to Complement, so federation coverage remains more limited.
- The wrapper keeps the current Durable Objects, D1, KV, R2, and Workflows shape intact rather than attempting a reduced local runtime.
