#!/usr/bin/env bash
# Regression tests for content-policy.sh ignore handling.
# Synthetic BLOCK strings only — never live credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/public-repo-guard/content-policy.sh"
# 32 hex zeros: matches the Cloudflare account_id BLOCK shape, not a live account.
BLOCK_CF='account_id = "00000000000000000000000000000000"'
fail=0

run_policy() {
  local tree="$1"
  (
    cd "$tree"
    unset GUARD_PRIVATE_REPOS || true
    bash "$SCRIPT" .
  )
}

expect_block() {
  local name="$1" tree="$2"
  local rc=0
  out="$(run_policy "$tree" 2>&1)" || rc=$?
  if (( rc == 0 )) || [[ "$out" == *"content policy OK"* ]]; then
    echo "FAIL: $name — expected BLOCK, gate exited 0"
    fail=1
  else
    echo "PASS: $name — gate blocked"
  fi
}

expect_ok() {
  local name="$1" tree="$2"
  local rc=0
  out="$(run_policy "$tree" 2>&1)" || rc=$?
  if (( rc != 0 )) || [[ "$out" != *"content policy OK"* ]]; then
    echo "FAIL: $name — expected OK, rc=$rc"
    printf '%s\n' "$out" | tail -n 20
    fail=1
  else
    echo "PASS: $name — gate clean"
  fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT

# 1. A BLOCK-shaped Cloudflare account_id is detected.
t="$WORKDIR/plain-block"
mkdir -p "$t"
printf '%s\n' "$BLOCK_CF" >"$t/leak.txt"
expect_block "plain BLOCK hit" "$t"

# 2. .rgignore '*' must not hide that BLOCK (the bug this test locks).
t="$WORKDIR/rgignore-block"
mkdir -p "$t"
printf '%s\n' "$BLOCK_CF" >"$t/leak.txt"
printf '*\n' >"$t/.rgignore"
expect_block ".rgignore must not hide BLOCK hits" "$t"

# 3. .ignore '*' must not hide that BLOCK either.
t="$WORKDIR/ignore-block"
mkdir -p "$t"
printf '%s\n' "$BLOCK_CF" >"$t/leak.txt"
printf '*\n' >"$t/.ignore"
expect_block ".ignore must not hide BLOCK hits" "$t"

# 4. A committed .env plus .rgignore '*' must still BLOCK.
t="$WORKDIR/dotenv-rgignore"
mkdir -p "$t"
printf 'FOO=bar\n' >"$t/.env"
printf '*\n' >"$t/.rgignore"
expect_block ".rgignore must not hide committed .env" "$t"

# 5. Documented .guardignore still excludes a named path, while a sibling hit BLOCKS.
t="$WORKDIR/guardignore"
mkdir -p "$t"
printf '%s\n' "$BLOCK_CF" >"$t/kept.txt"
printf '%s\n' "$BLOCK_CF" >"$t/skipped.txt"
printf 'skipped.txt\n' >"$t/.guardignore"
expect_block ".guardignore still allows a sibling BLOCK hit" "$t"
out="$(run_policy "$t" 2>&1 || true)"
if [[ "$out" == *"skipped.txt"* ]]; then
  echo "FAIL: .guardignore named path was still reported"
  fail=1
else
  echo "PASS: .guardignore named path stays excluded"
fi

# 6. Live checkout remains clean under the same flags.
expect_ok "live tree" "$ROOT"

if (( fail > 0 )); then
  echo "content-policy.test.sh: $fail failure(s)"
  exit 1
fi
echo "content-policy.test.sh: all passed"
