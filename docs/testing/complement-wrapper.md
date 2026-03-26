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

The wrapper expects Complement to provide:

- `SERVER_NAME`
- `/complement/ca/ca.crt`
- `/complement/ca/ca.key`

If the CA files are absent, the container falls back to a self-signed certificate so the image can still be started manually.

## Runtime Notes

- The entrypoint writes `.dev.vars` at container start so `SERVER_NAME` and the feature profile can be injected into `wrangler dev`.
- Local state is stored under `/data/wrangler`.
- The wrapper applies `migrations/schema.sql` and then the numbered files under `migrations/` on every start with `wrangler d1 execute --local`.
- The wrapper image uses Node.js to execute Wrangler even though the repository itself uses `bun`, because Wrangler's local runtime path is not supported under Bun.
- Optional integrations such as email, LiveKit VPC service, and Cloudflare remote-only bindings are intentionally left out of the Complement config.

## Current Limits

- This validates the local `wrangler dev` execution surface, not Cloudflare's deployed runtime behavior.
- Complement out-of-repo currently supports CSAPI-oriented testing well, but mock federation servers are still internal to Complement, so federation coverage remains more limited.
- The wrapper keeps the current Durable Objects, D1, KV, R2, and Workflows shape intact rather than attempting a reduced local runtime.
