#!/usr/bin/env bash
# WAVE public-repo BODY policy — the internal-leak gate for PR/issue/comment text.
#
# Companion to content-policy.sh. That script scans the published working TREE;
# this one scans the other half of a public repo's surface: pull-request titles
# and bodies, issue bodies, and comment bodies. Those are equally world-readable
# and, until this script existed, were scanned by NOTHING server-side. That gap
# was not theoretical — a PR was merged whose wrangler.toml was correctly BLOCKED
# for naming a private repo while the PR body named the same repo, with more
# operational detail attached, and sailed through.
#
# Usage: scripts/public-repo-guard/body-policy.sh <file>
#   <file> holds the untrusted text, already materialized to disk. It is passed as
#   a PATH and only ever read — the body is never interpolated into a command line
#   or an environment variable, so no amount of shell metacharacters in a PR body
#   can influence what runs here.
#
# Exit: 0 clean · 1 blocking violation · 2 scanner error (fail closed).
#
# Allowlisting: unlike the tree scanner, where a `guard:allow` marker lands in a
# reviewable diff, a body is free-form text the untrusted author controls and can
# edit at any time — an allowlist marker there is one edit away, not one review
# away. So BOTH allowlists (the `guard:allow <reason>` marker and the
# ABOUT-THE-CONTROL list below) apply ONLY to the self-referential PROSE rule
# (internal-marker) — never to the credential-format, infrastructure, or
# private-repo-topology rules, which have NO author-controlled escape in a body. The
# residual prose-rule escape is an accepted trade: the threat model is the
# accidental paste, and a gate that blocks its own security discussions gets
# switched off.
set -uo pipefail

FILE="${1:-}"
[[ -n "$FILE" && -f "$FILE" ]] || { echo "::error::body-policy: usage: body-policy.sh <file>"; exit 2; }
command -v rg >/dev/null 2>&1 || { echo "::error::body-policy: ripgrep (rg) required"; exit 2; }

# Every rule below runs through `rg -P` (PCRE2), because the lookarounds demand it,
# but not every ripgrep BUILD ships PCRE2 (Ubuntu's apt package does not). On such
# a build the first rule would die with an opaque "ripgrep failed (exit 2)". Probe
# once, up front, with an error that names the actual problem. The probe exercises
# a lookbehind so it fails on exactly the builds the rules fail on.
printf 'pcre2-probe' | rg -qP '(?<!x)pcre2-probe' >/dev/null 2>&1 || {
  echo "::error::body-policy: this ripgrep build lacks PCRE2 support (rg -P); every rule here requires it. Install a PCRE2-enabled ripgrep (rg --pcre2-version must succeed)."
  exit 2
}

VIOLATIONS=0

# Lines that TALK ABOUT the control rather than leaking through it. Without this,
# the gate blocks its own pull requests and every security discussion — the
# self-referential trap that gets a gate switched off. Ported verbatim in intent
# from the client-side gate's allowlist, which was built for exactly this.
#
# SCOPE: this allowlist applies ONLY to the rule that can self-trip on pure prose
# when a body DESCRIBES the control (internal-marker, below). It must NEVER apply
# to the credential-format, infrastructure-identifier, or private-repo-topology
# rules: a live key is a live key even when the sentence around it names the gate,
# and PRs about this gate are exactly the ones whose bodies contain these words.
# Those rules take no allowlist at all in a body — see private-repo-ops below.
ABOUT_THE_CONTROL='(public-repo-guard|body-policy|content-policy|public-github-write-gate|\bNDA\s+(gate|guard|policy|denylist|sweep|scan|hook)\b|\bno\s+NDA\b|responsib\w*\s+disclos|SECURITY\.md)'

# check <BLOCK|WARN> <name> <regex> <why> [about-the-control-exempt]
#   Pass the literal string `about-the-control-exempt` as the 5th argument to let
#   lines matching ABOUT_THE_CONTROL or carrying `guard:allow <reason>` through.
#   Only self-referential prose rules may opt in; hard-format rules must not —
#   in a body both escapes are author-controlled, so a live key stays a hit no
#   matter what else its line says.
check() {
  local sev="$1" name="$2" re="$3" why="$4" about_exempt="${5:-}"
  [[ -z "$re" ]] && { echo "::error::body-policy: internal bug — empty regex for rule '$name'"; exit 2; }
  # rg exit: 0=match, 1=no match, >=2=real error → FAIL CLOSED. A gate that passes
  # because its scanner broke is worse than no gate: it reports success.
  local raw rc
  raw="$(rg -nP --no-filename -- "$re" "$FILE" 2>/dev/null)"; rc=$?
  if (( rc >= 2 )); then
    echo "::error title=public-repo-guard ($name)::ripgrep failed (exit $rc) scanning rule '$name' — failing closed."
    exit 2
  fi
  # Filter with rg, not grep: BSD/macOS grep has no -P, so a `grep -P` allowlist
  # silently errors out locally while working on GNU/CI — the gate would then
  # disagree with itself depending on where it ran. rg is already required above.
  #
  # The filters fail closed too: exit 1 just means every line was filtered (fine),
  # but >=2 is a scanner error, and treating it as "no matches" would turn a broken
  # allowlist into a green check over real hits.
  #
  # BOTH allowlists live inside the opt-in branch: a body has no reviewable diff,
  # so the untrusted author could otherwise neutralize any rule — including the
  # live-credential rules — by appending `guard:allow <reason>` to the same line.
  # Only the self-referential prose rules may be exempted, and only because their
  # alternative (blocking every discussion of the gate itself) gets the gate
  # switched off.
  local matches="$raw"
  if [[ "$about_exempt" == "about-the-control-exempt" ]]; then
    matches="$(printf '%s' "$matches" \
      | rg -vN -- 'guard:allow[[:space:]]+[^[:space:]]')"; rc=$?
    if (( rc >= 2 )); then
      echo "::error title=public-repo-guard ($name)::ripgrep failed (exit $rc) applying the guard:allow filter for rule '$name' — failing closed."
      exit 2
    fi
    matches="$(printf '%s' "$matches" | rg -vNiP -- "$ABOUT_THE_CONTROL")"; rc=$?
    if (( rc >= 2 )); then
      echo "::error title=public-repo-guard ($name)::ripgrep failed (exit $rc) applying the about-the-control allowlist for rule '$name' — failing closed."
      exit 2
    fi
  fi
  [[ -z "$matches" ]] && return 0
  local count; count="$(printf '%s\n' "$matches" | grep -c '')"
  # Print the LINE NUMBER only — never the matched text. This annotation is itself
  # world-readable, so echoing the hit would re-publish the very thing we caught.
  echo "::group::[$sev] $name — $why"
  printf '%s\n' "$matches" | sed -E 's/^([0-9]+):.*/  line \1: «match redacted — view the body to see it»/'
  echo "::endgroup::"
  if [[ "$sev" == "BLOCK" ]]; then
    echo "::error title=public-repo-guard ($name)::$why — $count occurrence(s) in the title/body. Edit the body to remove it, then re-run."
    VIOLATIONS=$((VIOLATIONS+1))
  else
    echo "::warning title=public-repo-guard ($name)::$why — $count occurrence(s) (non-blocking; review)."
  fi
}

# --- Credential formats — never legitimate in prose --------------------------
check BLOCK stripe-live-key  '(sk|rk)_live_[A-Za-z0-9]{16,}'                 'Live Stripe secret/restricted key'
check BLOCK stripe-account   'acct_[A-Za-z0-9]{16,}'                         'Live Stripe account ID — financial infra, never publish'
check BLOCK anthropic-key    'sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}' 'Real Anthropic API/admin key'
check BLOCK github-pat       'github_pat_[A-Za-z0-9_]{30,}'                  'GitHub fine-grained PAT'
check BLOCK supabase-pat     'sbp_[a-f0-9]{40}'                              'Supabase personal access token'
check BLOCK aws-akid         'AKIA[0-9A-Z]{16}'                              'AWS access key ID'
check BLOCK private-key      '-----BEGIN [A-Z ]*PRIVATE KEY-----'            'Embedded private key material'

# --- Infrastructure identifiers ----------------------------------------------
# shellcheck disable=SC2016  # $CLOUDFLARE_ACCOUNT_ID is literal guidance text
check BLOCK cf-account-id    'account_id\s*[:=]\s*["'"'"']?[0-9a-f]{32}'      'Hardcoded Cloudflare account_id — reference the env var instead'
# The leading lookahead exempts the range's own DESIGNATION — the all-zero
# network address 100.64.0.0, with or without a CIDR suffix. That string is the
# public NAME of the CGNAT range (it appears in this rule's own message), and
# infrastructure rules deliberately accept no allowlist marker, so matching it
# would block every body that so much as quotes the gate's documentation, with
# no remedy short of deleting the text. Every real fleet address — any host
# with a non-zero octet — is still a hit.
check BLOCK internal-ip      '(?!100\.64\.0\.0(?:/[0-9]{1,2})?(?![0-9]))100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'  'Internal Tailscale-CGNAT IP (100.64.0.0/10) — internal fleet address'
# shellcheck disable=SC2016  # $HOME is literal guidance text
check BLOCK abs-user-path    '/(Users|home)/(?!runner/)[a-z][a-z0-9._-]+/'    'Operator absolute home path — leaks identity and local layout'

# --- Self-identified internal material ---------------------------------------
# USE vs MENTION. A body that SAYS "internal-only" is leaking; a body that QUOTES
# the phrase is describing a policy — including this one. The lookarounds exempt a
# marker wrapped in straight, smart, or backtick quotes.
#
# Not hypothetical: the first run of this job failed on its own pull request,
# because a review bot had edited the PR body to summarize the change and its
# summary quoted the phrase verbatim. The line-level allowlist could not help —
# that line named no gate. Only use-vs-mention separates the two.
#
# A quoted marker is also a trivial bypass, and that is an accepted trade. The
# threat here is the ACCIDENTAL paste; a deliberate evader has easier routes, and
# `guard:allow <reason>` already exists as the honest, visible one.
check BLOCK internal-marker  '(?<![“"'"'"'`])\b(internal[- ]only|do\s+not\s+(share|publish|distribute)|for\s+internal\s+use)\b(?![”"'"'"'`])' 'Text self-identifies as not-for-public' about-the-control-exempt

# --- Private repo + operational detail (PROXIMITY, not bare name) ------------
# The BODY profile deliberately DIVERGES from the FILE profile here, and the
# divergence is the whole design. content-policy.sh blocks a bare private-repo
# name outright, which is right for a checked-in file. Applying that to bodies
# would be unusable: a sweep of public issues found 134 LEGITIMATE cross-repo
# references ("companion to <private-repo>#260"). A gate that fires on all of
# those gets switched off, and then it protects nothing.
#
# So a bare mention stays silent. What fires is a private repo name within ~140
# characters of INTERNAL OPERATIONAL DETAIL — a SCREAMING_CASE credential NAME, a
# secret-binding verb, a service binding, or a secret COUNT. That is the topology
# of what is wired to what, and it is the shape that actually leaked.
#
# Names are NOT hardcoded (this file is public); CI injects them via the
# GUARD_PRIVATE_REPOS variable.
#
# Availability is enforced, not assumed. This rule is the one the gate exists
# for, and every other error path in this file fails closed — so "the org
# variable is unset, misspelled, or not exposed to this run" must not be the
# single path that prints "body policy OK" over an unscanned leak class. In CI
# (GITHUB_ACTIONS set) an empty value is therefore a configuration error, exit
# 2. A repo with deliberately nothing to guard opts out EXPLICITLY with the
# literal value `none`. Local runs (no GITHUB_ACTIONS) still skip quietly:
# contributors do not have the org variable, and the fixtures pin their own.
if [[ -z "${GUARD_PRIVATE_REPOS:-}" ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error title=public-repo-guard (private-repo-ops)::GUARD_PRIVATE_REPOS is empty in CI — the private-repo rule would silently not run and this check would report a pass it never earned. Set the GUARD_PRIVATE_REPOS org/repo variable, or set it to the literal 'none' to record that there is deliberately nothing to guard."
    exit 2
  fi
elif [[ "${GUARD_PRIVATE_REPOS}" != "none" ]]; then
  # Case-insensitivity is scoped per alternative with (?i:...). The SCREAMING_CASE
  # credential-NAME alternative must stay case-EXACT — that casing is the whole
  # signal ("api_key" in prose is not a credential name) — while the prose verbs
  # and the repo names themselves match in any case.
  OPS_DETAIL='(?:[A-Z][A-Z0-9]*_(?:SECRET|TOKEN|KEY|PASSWORD)|(?i:wrangler\s+secret|secret\s+(?:is\s+)?(?:bound|binding|list)|(?:is\s+)?bound\s+on|service\s+binding)|\d{2,}\s+secrets)'
  _ALT=''
  # The org variable may be comma- OR newline-separated; `read` stops at the first
  # newline, which would silently configure only the first name and report a pass
  # over the unscanned rest. Normalize newlines to spaces before splitting — and
  # carriage returns too: a CRLF-stored value would otherwise leave an invisible
  # \r glued to each name, so the built regex matches nothing and the gate
  # fail-opens with no diagnostic.
  IFS=', ' read -r -a _PRIV <<< "${GUARD_PRIVATE_REPOS//[$'\n'$'\r']/ }"
  for _name in "${_PRIV[@]}"; do
    [[ -z "$_name" ]] && continue
    # Regex-escape so metacharacters in a name match literally.
    _esc="$(printf '%s' "$_name" | sed -E 's/[][(){}.^$*+?|\\]/\\&/g')"
    _ALT="${_ALT:+$_ALT|}${_esc}"
  done
  if [[ -n "$_ALT" ]]; then
    # Both orders: name-then-detail and detail-then-name.
    #
    # Deliberately STRICT — no 5th argument, so NEITHER allowlist reaches this
    # rule. It already tolerates a bare mention, so the only way to trip it is a
    # private repo name sitting NEXT TO operational detail, and that is a leak
    # even on a line that also names the gate ("public-repo-guard now blocks
    # FOO_SECRET bound on <private repo>" is precisely the topology this rule
    # exists for). Both escapes are author-controlled in a body — one edit, not
    # one review — so a documented safe example belongs in a FILE, where
    # `guard:allow <reason>` lands in a reviewable diff.
    check BLOCK private-repo-ops \
      "\\b(?i:${_ALT})\\b[^\\n]{0,140}?\\b${OPS_DETAIL}|${OPS_DETAIL}[^\\n]{0,140}?\\b(?i:${_ALT})\\b" \
      'A private WAVE repo named alongside internal operational detail (credential name, secret binding, or secret count) — the wiring topology is not public'
  fi
fi

if (( VIOLATIONS > 0 )); then
  echo "::error::public-repo-guard: $VIOLATIONS blocking body-policy violation(s) — see annotations above."
  exit 1
fi
echo "public-repo-guard: body policy OK"
