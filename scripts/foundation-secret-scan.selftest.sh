#!/usr/bin/env bash
# Regression test for scripts/foundation-secret-scan.sh.
#
# Proves two things:
#   1. The historical `echo "$HITS"` pipeline includes a runtime canary
#      (the defect this fix closes).
#   2. The redacting scanner prints file:line + a redaction marker and
#      never the canary value.
#
# The canary is constructed at runtime so git never stores a secret-shaped
# fixture. Exits 0 only when both assertions hold and the repo tree itself
# is clean under the same scanner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAN="$ROOT/scripts/foundation-secret-scan.sh"
PATTERN='(sk-[A-Za-z0-9]{20}|sk_(live|test)_[A-Za-z0-9]{20}|npm_[A-Za-z0-9]{30}|sbp_[a-f0-9]{40}|github_pat_[A-Za-z0-9_]{40}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30}|AIzaSy[A-Za-z0-9_-]{20}|xai-[A-Za-z0-9]{40}|xoxb-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY)'

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Runtime canary matching sk_live_[A-Za-z0-9]{20} — not a real credential.
CANARY="sk_live_$(python3 -c 'print("A" * 24)')"
printf 'const token = "%s";\n' "$CANARY" > "$WORKDIR/leak.js"

# --- 1. Unredacted pipeline (the bug) must include the canary --------------
UNREDACTED=$(grep -rIEn "$PATTERN" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist "$WORKDIR" \
  | grep -v 'allowlist secret' || true)
if [[ "$UNREDACTED" != *"$CANARY"* ]]; then
  echo "selftest: expected unredacted grep to include the runtime canary (documents the defect)" >&2
  exit 1
fi

# --- 2. Redacting scanner must fail closed without echoing the canary ------
set +e
REDACTED="$("$SCAN" "$WORKDIR" 2>&1)"
STATUS=$?
set -e
if [[ "$STATUS" -eq 0 ]]; then
  echo "selftest: expected scanner to exit non-zero on a matching canary" >&2
  exit 1
fi
if [[ "$REDACTED" == *"$CANARY"* ]]; then
  echo "selftest: redacting scanner leaked the canary into stdout/stderr" >&2
  exit 1
fi
if [[ "$REDACTED" != *"leak.js:1"* ]]; then
  echo "selftest: expected file:line (leak.js:1) in redacted output" >&2
  exit 1
fi
if [[ "$REDACTED" != *"match redacted"* ]]; then
  echo "selftest: expected redaction marker in output" >&2
  exit 1
fi

# --- 3. This repository's tree must stay clean under the same scanner ------
"$SCAN" "$ROOT"

echo "foundation-secret-scan.selftest: ok"
