#!/usr/bin/env bash
# Fixture tests for body-policy.sh.
#
# Deliberately fixture-only: the gate is NEVER proved by writing a real leak into a
# live public PR body, because doing so would publish the exact thing it guards.
#
# The negatives here are the load-bearing half. A leak gate that blocks everything
# is trivially "correct" and useless — it gets disabled within a week. The bare
# cross-reference case below is the one that keeps this gate deployable.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/body-policy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The names the real gate is configured with come from an org variable; the tests
# pin their own so they are hermetic and do not depend on CI configuration. The
# names (and every credential name and count below) are deliberately SYNTHETIC:
# this file is public and exempt from the gates by path, so real private-repo
# names or real credential names here would BE the leak the gate exists to block.
export GUARD_PRIVATE_REPOS="acme-alpha, acme-beta, acme-gamma"

PASS=0; FAIL=0

# expect <exit-code> <name> <body-text>
expect() {
  local want="$1" name="$2" body="$3" out rc
  printf '%s\n' "$body" > "$TMP/body.txt"
  out="$(bash "$SCRIPT" "$TMP/body.txt" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit %s, got %s\n%s\n' "$name" "$want" "$rc" "$out"
  fi
  # The annotation is world-readable; a hit must never echo the matched text.
  if [[ "$rc" == 1 ]] && printf '%s' "$out" | grep -qF "$body"; then
    FAIL=$((FAIL+1)); printf '  FAIL %s — LEAKED the matched text into the annotation\n' "$name"
  fi
}

echo "body-policy fixtures"

# --- must BLOCK ---------------------------------------------------------------
expect 1 'private repo + credential name' \
  'Flip is live: ALPHA_VIEWPORT_LEASE_SECRET is bound on acme-alpha now.'
expect 1 'private repo + credential name, reverse order' \
  'The BETA_JOIN_SECRET was added; acme-beta picks it up on deploy.'
expect 1 'private repo + secret count' \
  'acme-alpha went from 74 secrets to 75 after this change.'
expect 1 'private repo + service binding' \
  'This adds a service binding from the worker to acme-gamma for settlement.'
# Case-insensitivity is scoped to the repo NAME alternation, not the whole rule.
expect 1 'repo name still matches case-insensitively' \
  'Acme-Alpha went from 74 secrets to 75 after this change.'
expect 1 'operator home path' \
  'Repro: run it from /Users/someoperator/Documents/notes and it fails.'  # enforce-ignore (fixture)
expect 1 'internal-only marker' \
  'Attaching the internal-only rollout plan for context.'
# Assembled at run time rather than written as a literal: a fixture that LOOKS like
# a live AWS key trips this repo's own pre-commit secret scanners (it did, on the
# first draft). Splitting the prefix keeps the fixture exercising the real regex
# without parking a credential-shaped string in source.
AKID_FIXTURE="AKI""A1234567890ABCDEF"
expect 1 'AWS access key id' \
  "The failing job had ${AKID_FIXTURE} configured."
# Regression: the about-the-control allowlist is scoped to PROSE rules only. A
# credential-format hit must still block on a line that names the gate — gate
# discussions are exactly where an accidental paste is most likely to land.
expect 1 'credential format blocks even on a line naming the control' \
  "public-repo-guard flagged ${AKID_FIXTURE} in the job logs."
expect 1 'internal tailscale IP' \
  'It resolves to 100.71.4.19 from inside the fleet.'
# Regression: naming the gate does not sanitize topology. The about-the-control
# allowlist is scoped to the internal-marker rule only — a line that says
# "public-repo-guard" AND wires a private repo to a credential name is exactly
# the leak private-repo-ops exists for.
expect 1 'private repo + credential name blocks even on a line naming the control' \
  'public-repo-guard fires when acme-alpha sits near a BAR_SECRET name; expected.'

# --- must PASS (precision — these keep the gate deployable) -------------------
expect 0 'bare private-repo cross-reference' \
  'This is the companion change to acme-beta#260; merge that one first.'
expect 0 'two private repos, no operational detail' \
  'Both acme-alpha and acme-beta will need a follow-up for this.'
expect 0 'credential NAME with no private repo nearby' \
  'The handler now reads SOME_API_TOKEN from the environment instead of a literal.'
# Regression: a top-level (?i) once leaked into OPS_DETAIL and made the
# SCREAMING_CASE credential rule match ordinary lowercase identifiers.
expect 0 'lowercase identifier near a private repo is prose, not a credential' \
  'In acme-alpha we renamed the cache_key format for the edge.'
expect 0 'public runner path is not an operator path' \
  'CI checks out to /home/runner/work/repo/repo before the scan runs.'  # enforce-ignore (fixture)
expect 0 'talking about the control' \
  'body-policy blocks a private repo named next to a SECRET_TOKEN; that is intended.'
expect 0 'internal-marker stays exempt on a line naming the control' \
  'public-repo-guard exists so an internal-only doc never lands in a public body.'
expect 0 'explicit guard:allow with a reason' \
  'Example for the docs: acme-alpha holds EXAMPLE_SECRET — guard:allow documented-example'
expect 0 'ordinary clean body' \
  'Bumps the draft revision and regenerates the fixtures. No behaviour change.'
# Regression: the first CI run of this job failed on its own PR, because a review
# bot edited the body to summarize the change and quoted the marker verbatim.
expect 0 'marker MENTIONED in straight quotes is a description' \
  'Blocks infra identifiers and markers (account_id, home paths, "internal-only" text).'
expect 0 'marker MENTIONED in a code span' \
  'The rule matches `internal-only` and `for internal use` in body text.'
expect 0 'marker MENTIONED in smart quotes' \
  'Blocks operator home paths and “internal-only” text.'
expect 1 'marker USED unquoted still blocks' \
  'Attaching the internal-only rollout plan; do not share outside the team.'

# --- GUARD_PRIVATE_REPOS availability -----------------------------------------
# In CI, an empty GUARD_PRIVATE_REPOS is a configuration error (exit 2): the
# private-repo rule is the one this gate exists for, and an unset, misspelled,
# or unexposed org variable must be a red check, never a silent skip that still
# reports "body policy OK". Locally (no GITHUB_ACTIONS) the skip stays quiet,
# and the literal 'none' is the explicit CI opt-out for a repo with nothing to
# guard. Invoked via env(1), not expect(): these must NOT inherit the export above.
printf '%s\n' 'Ordinary clean body text.' > "$TMP/envcase.txt"
envcase() {
  local want="$1" name="$2"; shift 2
  env -u GUARD_PRIVATE_REPOS -u GITHUB_ACTIONS "$@" bash "$SCRIPT" "$TMP/envcase.txt" >/dev/null 2>&1
  local rc=$?
  if [[ "$rc" == "$want" ]]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit %s, got %s\n' "$name" "$want" "$rc"
  fi
}
envcase 2 'empty GUARD_PRIVATE_REPOS in CI fails closed' GITHUB_ACTIONS=true
envcase 0 'empty GUARD_PRIVATE_REPOS locally skips quietly'
envcase 0 "explicit 'none' opt-out passes in CI" GITHUB_ACTIONS=true GUARD_PRIVATE_REPOS=none

# --- fail closed --------------------------------------------------------------
# Invoked directly, not through expect(): expect() always materializes a file, so
# it cannot reach these paths. A gate that returns "OK" when it was handed nothing
# to scan is the failure mode this whole file exists to prevent.
for case in "no argument at all::" "nonexistent path::$TMP/does-not-exist.txt"; do
  name="${case%%::*}"; arg="${case##*::}"
  if [[ -n "$arg" ]]; then bash "$SCRIPT" "$arg" >/dev/null 2>&1; else bash "$SCRIPT" >/dev/null 2>&1; fi
  rc=$?
  if [[ "$rc" == 2 ]]; then
    PASS=$((PASS+1)); printf '  ok   %s → exit 2 (fails closed)\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit 2, got %s\n' "$name" "$rc"
  fi
done

echo "  ---"
if (( FAIL > 0 )); then
  echo "  $PASS passed, $FAIL FAILED"; exit 1
fi
echo "  $PASS passed, 0 failed"
