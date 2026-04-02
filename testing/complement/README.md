# Complement Harness

This directory contains the local Complement test harness and startup diagnostics.

## Structure

- [`run.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/run.ts)
  - package-aware Complement runner
  - writes `.summary.json` and `.classified.json` artifacts
- [`harness.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/harness.ts)
  - package resolution
  - log classification
  - summary artifact generation
- [`log.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/log.ts)
  - raw Go test JSON log parsing
- [`analyze.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/analyze.ts)
  - historical log delta analysis
- [`startup-preflight.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/startup-preflight.ts)
  - direct image startup profiling
  - supports `--instances` for multi-server startup timing
- [`docker/`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/docker)
  - Complement-only Docker wrapper
  - split shell libs for state, certs, wrangler, nginx, and JSON startup logging
- [`setup.ts`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/setup.ts)
  - pins and prepares the local Complement checkout
- [`index-tests.mjs`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/index-tests.mjs)
  - regenerates the checked-in test-name to package index
- [`test-index.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/testing/complement/test-index.json)
  - checked-in package lookup for auto-narrowed targeted runs

## Environment

Runtime env used by the runner:

- `COMPLEMENT_DIR`
  - local Complement checkout path
- `IMAGE`
  - Docker image name for the homeserver wrapper
- `NO_BUILD`
  - `1` skips image rebuild
- `DIRTY`
  - `1` skips container-side DB reset behavior
- `PARALLEL`
  - passed to `go test -parallel`
- `LOG`
  - explicit raw log output path
- `DOCKER_LOGS`
  - `1` captures sidecar Docker logs

Complement-profile env injected into the container:

- `MATRIX_FEATURE_PROFILE=complement`
- `COMPLEMENT_SHARE_ENV_PREFIX=FAASMATRIX_`

Debug-only runner behavior:

- `--startup-debug`
  - raises spawn timeout default to 60s
  - enables always-print-server-logs
  - raises Wrangler log verbosity

Timeout defaults:

- targeted runs: `40s`
- full runs and `--pkg ./tests`: `60s`
- `--startup-debug`: `60s`
- `--spawn-timeout <seconds>` overrides any default

## Usage

```bash
bun run complement:index
bun run complement:run -- TestAddAccountData
bun run complement:run -- --pkg ./tests/csapi TestAddAccountData
bun run complement:run -- --list-packages TestContentMediaV1
bun run complement:startup:preflight -- --iterations 3 --instances 2
```
