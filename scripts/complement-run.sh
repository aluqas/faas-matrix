#!/usr/bin/env bash
# Run specific Complement tests and show pass/fail summary.
#
# Usage:
#   ./scripts/complement-run.sh [TestName1 TestName2 ...]
#
# Examples:
#   ./scripts/complement-run.sh TestWriteMDirectAccountData TestACLs
#   ./scripts/complement-run.sh                              # runs all tests
#
# Environment:
#   COMPLEMENT_DIR  path to complement checkout (default: .saqula/complement)
#   IMAGE           docker image name (default: complement-faas-matrix)
#   NO_BUILD        skip docker build if set to 1
#   LOG             log file path (default: .saqula/complement-run.log)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPLEMENT_DIR="${COMPLEMENT_DIR:-${REPO_ROOT}/.saqula/complement}"
IMAGE="${IMAGE:-complement-faas-matrix}"
LOG="${LOG:-${REPO_ROOT}/.saqula/complement-run.log}"
NO_BUILD="${NO_BUILD:-0}"

# Build test filter
if [ $# -gt 0 ]; then
  # Join args with | for -run regex
  RUN_FILTER="$(IFS='|'; echo "$*")"
else
  RUN_FILTER=""
fi

# Build image unless skipped
if [ "${NO_BUILD}" != "1" ]; then
  echo "==> Building Docker image ${IMAGE}..."
  docker build -f "${REPO_ROOT}/docker/complement/Dockerfile" \
    -t "${IMAGE}" "${REPO_ROOT}" 2>&1 | tail -5
fi

echo "==> Running tests${RUN_FILTER:+ (filter: ${RUN_FILTER})}..."
echo "    Log: ${LOG}"

cd "${COMPLEMENT_DIR}"

RUN_ARGS=(-json -count=1)
[ -n "${RUN_FILTER}" ] && RUN_ARGS+=(-run "${RUN_FILTER}")

COMPLEMENT_BASE_IMAGE="${IMAGE}" go test ./tests/... "${RUN_ARGS[@]}" \
  > "${LOG}" 2>&1 || true

# Parse results
python3 - "${LOG}" << 'PYEOF'
import json, sys

log_path = sys.argv[1]
passes, fails = [], []

with open(log_path) as f:
    for line in f:
        try:
            obj = json.loads(line)
            t = obj.get('Test')
            if not t:
                continue
            action = obj.get('Action')
            if action == 'pass':
                passes.append(t)
            elif action == 'fail':
                fails.append(t)
        except Exception:
            pass

# Top-level only
top_pass = [t for t in passes if '/' not in t]
top_fail = [t for t in fails  if '/' not in t]

print()
print(f"{'='*60}")
print(f"  PASS: {len(top_pass)}  FAIL: {len(top_fail)}")
print(f"{'='*60}")

if top_fail:
    print("\nFAILED:")
    for t in sorted(top_fail):
        print(f"  ✗ {t}")

if top_pass:
    print("\nPASSED:")
    for t in sorted(top_pass):
        print(f"  ✓ {t}")
PYEOF
