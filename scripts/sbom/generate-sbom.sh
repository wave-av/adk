#!/usr/bin/env bash
# SUPPLY-001 (cw #4803) — generate an SPDX SBOM for the REAL PUBLISHED npm
# tarball of a released @wave-av/adk version, and stage it (alongside the
# tarball itself) into OUT_DIR for the caller to upload as a workflow
# artifact / attach to the GitHub Release.
#
# Runs from the `sbom` job in .github/workflows/_release-sbom.yml (a reusable
# workflow chained from release.yml), AFTER that job's "Resolve target tag"
# and "Read package.json / package-lock.json from the target tag" steps.
#
# IMPORTANT: the caller does NOT check out the target tag as its working
# tree. A workflow_dispatch backfill can target a tag that PREDATES this
# script (e.g. v1.0.15, published before this SBOM job existed) -- checking
# that tag out wholesale would delete scripts/sbom/generate-sbom.sh itself
# before it could run. Instead the caller stays on the WORKFLOW's own
# revision (guaranteeing this script exists) and passes in the two files
# whose CONTENT must reflect the historical tag -- package.json and
# package-lock.json -- as TAG_PKG_JSON / TAG_LOCKFILE, fetched via `git show
# <tag>:<path>` against a full-history checkout. Everything below reads
# THOSE files, never a bare `./package.json` / `./package-lock.json` from cwd.
#
# Deliberately pulls the tarball from the npm REGISTRY (`npm pack <name>@<ver>`)
# rather than repacking the locally built tree — the SBOM must describe what a
# consumer actually installs, not a local rebuild that could drift from it.
# This registry lookup is also the actual proof the version exists: a bad
# backfill TAG_NAME fails here, before anything touches the GitHub Release.
#
# adk's release.yml has no `release` job at all (unlike the mcp-server / cli
# release workflows this is modelled on) — the sibling `release` job in
# _release-sbom.yml creates the GitHub Release itself, attaching both this
# SBOM and the packed tarball (staged into OUT_DIR by this script) in ONE
# `gh release create`/`upload` call, so a Release for this repo is never
# visible without its SBOM.
#
# Inputs (env):
#   TAG_NAME     - the exact tag to SBOM (e.g. "v1.0.15"), already validated
#   OUT_DIR      - existing directory to stage the tarball + SBOM asset into
#   TAG_PKG_JSON - path to that tag's package.json (fetched via `git show`)
#   TAG_LOCKFILE - path to that tag's package-lock.json, or "" if that tag
#                  predates the lockfile — see step 2 below: this script
#                  FAILS CLOSED rather than approximate an SBOM from
#                  semver-range resolution against whatever the registry's
#                  latest-satisfying versions happen to be today, which could
#                  silently describe different (newer) dependency versions
#                  than the ones consumers actually received for that release.
#
# Exits non-zero on any failure. Scoped supply-chain guarantees: the syft
# binary is pinned to an exact version and verified against syft's OWN
# published checksums.txt (fetched from the same immutable GitHub Release,
# over HTTPS) before it is ever executed — no installer script, no floating
# tag/branch ref. Every production dependency pulled into node_modules is
# verified against the SRI integrity hash recorded in the tag's own
# package-lock.json via `npm ci`. The top-level tarball itself is fetched
# over HTTPS from the npm registry by package name + exact version (no local
# checksum pin) — the same trust boundary this workflow's `publish` job
# already relies on (OIDC trusted publishing + `--provenance`).
set -euo pipefail

: "${TAG_NAME:?TAG_NAME required (resolve + validate it before calling this script)}"
: "${OUT_DIR:?OUT_DIR required (existing directory to stage outputs into)}"
: "${TAG_PKG_JSON:?TAG_PKG_JSON required (path to package.json for the target tag)}"
: "${TAG_LOCKFILE:=}"

if [[ ! "$TAG_NAME" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::TAG_NAME '$TAG_NAME' does not look like a semver tag (expected vX.Y.Z)"
  exit 1
fi
if [[ ! -f "$TAG_PKG_JSON" ]]; then
  echo "::error::TAG_PKG_JSON '$TAG_PKG_JSON' does not exist"
  exit 1
fi
# Fail closed, not soft: an SBOM built from semver-range resolution against
# TODAY's registry state can materially misdescribe what a consumer actually
# received for this release — worse than no SBOM at all for SUPPLY-001's
# purpose. Every tag produced by the gated `publish` job in release.yml has a
# lockfile (npm ci is required for that job to have passed); this only
# refuses tags that predate this repo's gate (e.g. v1.0.6 and earlier),
# which should not carry an approximated SBOM anyway.
if [[ -z "$TAG_LOCKFILE" ]]; then
  echo "::error::tag '$TAG_NAME' has no package-lock.json — refusing to generate an approximate SBOM from re-resolved semver ranges. This tag predates this repo's gated release path and is not a supported SBOM/backfill target."
  exit 1
fi
if [[ ! -f "$TAG_LOCKFILE" ]]; then
  echo "::error::TAG_LOCKFILE '$TAG_LOCKFILE' does not exist"
  exit 1
fi
mkdir -p "$OUT_DIR"

SYFT_VERSION="1.51.1"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "target tag: $TAG_NAME"

# ---------------------------------------------------------------------------
# 1. Pack the REAL PUBLISHED tarball from the npm registry. This IS the
#    registry-existence check: if this version was never published, this
#    fails here, before anything touches the GitHub Release for this tag.
# ---------------------------------------------------------------------------
PKG_VERSION="${TAG_NAME#v}"
PKG_NAME="$(node -p "require('${TAG_PKG_JSON}').name")"
echo "packing $PKG_NAME@$PKG_VERSION from the npm registry"

# Pass BOTH the default --registry and an explicit scope override
# (--<scope>:registry): a scoped package's registry is resolved from
# scope-specific config FIRST if one is set anywhere in the runner's npm
# config (e.g. a developer or org .npmrc pointing @wave-av at a different
# registry) — --registry alone would silently be ignored in that case and
# this could pack the wrong artifact. The SBOM must describe what a public
# `npm install @wave-av/adk` consumer actually gets, i.e. registry.npmjs.org.
NPM_SCOPE="${PKG_NAME%%/*}"
PACK_JSON="$(npm pack "${PKG_NAME}@${PKG_VERSION}" --json --pack-destination "$WORKDIR" \
  --registry https://registry.npmjs.org/ \
  "--${NPM_SCOPE}:registry=https://registry.npmjs.org/")"
TARBALL="$(node -e "process.stdout.write(JSON.parse(process.argv[1])[0].filename)" "$PACK_JSON")"
case "$TARBALL" in
  *.tgz) ;;
  *) echo "::error::npm pack --json reported '$TARBALL', not a .tgz filename"; exit 1 ;;
esac
TARBALL_PATH="$WORKDIR/$TARBALL"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "::error::npm pack reported '$TARBALL' but no such file exists at $TARBALL_PATH"
  exit 1
fi
echo "packed: $TARBALL_PATH"

EXTRACT_DIR="$WORKDIR/extracted"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TARBALL_PATH" -C "$EXTRACT_DIR"
# npm tarballs always extract into a top-level "package/" directory.
PKG_DIR="$EXTRACT_DIR/package"
if [[ ! -f "$PKG_DIR/package.json" ]]; then
  echo "::error::extracted tarball has no package/package.json at $PKG_DIR"
  exit 1
fi

# Defense in depth: `npm pack "name@X.Y.Z"` is an exact version spec (never a
# dist-tag/range) because PKG_VERSION was already validated as a plain semver
# string above — but confirm the manifest we actually got matches, so a
# registry/npm-client edge case surfaces as a loud error here instead of
# silently SBOM'ing the wrong version.
EXTRACTED_VERSION="$(node -p "require('${PKG_DIR}/package.json').version")"
if [[ "$EXTRACTED_VERSION" != "$PKG_VERSION" ]]; then
  echo "::error::extracted package.json version '$EXTRACTED_VERSION' does not match requested '$PKG_VERSION'"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Resolve the real production dependency tree into node_modules so the
#    SBOM covers what a consumer's `npm install` actually pulls in, not just
#    the top-level artifact. `npm ci` against TAG_LOCKFILE (the LOCKFILE FROM
#    THIS EXACT TAG, already validated non-empty above) gives exact,
#    reproducible version pins — the same lockfile the `publish` job itself
#    used — never a re-resolve of package.json's semver RANGES against
#    whatever the registry's latest-satisfying versions are today, which
#    would let a later backfill run describe different (newer) dependency
#    versions than the ones consumers actually received for this release.
# ---------------------------------------------------------------------------
echo "resolving production dependencies for the SBOM (npm ci against $TAG_LOCKFILE)"
cp "$TAG_LOCKFILE" "$PKG_DIR/package-lock.json"
( cd "$PKG_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )

# ---------------------------------------------------------------------------
# 3. Install syft (pinned release binary, verified against syft's OWN
#    published checksums.txt — same discipline as this workflow's gitleaks
#    install, but checksums.txt-based rather than a single hardcoded digest,
#    so a version bump only needs SYFT_VERSION touched, not a new sha256).
#    Deliberately NOT an installer script executed from a branch ref, and NOT
#    a third-party Action wrapping one — a straight pinned-binary download,
#    checksum-verified before it is ever executed.
# ---------------------------------------------------------------------------
echo "installing syft v${SYFT_VERSION}"
SYFT_BASE="https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}"
SYFT_TARBALL="syft_${SYFT_VERSION}_linux_amd64.tar.gz"
curl -fsSL --proto '=https' --tlsv1.2 \
  --retry 3 --retry-delay 2 --retry-all-errors \
  --connect-timeout 10 --max-time 120 \
  -o "$WORKDIR/$SYFT_TARBALL" \
  "$SYFT_BASE/$SYFT_TARBALL"
curl -fsSL --proto '=https' --tlsv1.2 \
  --retry 3 --retry-delay 2 --retry-all-errors \
  --connect-timeout 10 --max-time 60 \
  -o "$WORKDIR/checksums.txt" \
  "$SYFT_BASE/syft_${SYFT_VERSION}_checksums.txt"
EXPECTED_SHA="$(grep " ${SYFT_TARBALL}\$" "$WORKDIR/checksums.txt" | awk '{print $1}')"
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "::error::no checksum entry for $SYFT_TARBALL in syft's published checksums.txt"
  exit 1
fi
echo "${EXPECTED_SHA}  $WORKDIR/$SYFT_TARBALL" | sha256sum -c -
tar -xzf "$WORKDIR/$SYFT_TARBALL" -C "$WORKDIR" syft
sudo install -m 0755 "$WORKDIR/syft" /usr/local/bin/syft
syft version

# ---------------------------------------------------------------------------
# 4. Generate SPDX JSON for the INSTALLED tree: the extracted (published)
#    tarball contents plus the node_modules that `npm ci` resolved in step 2.
# ---------------------------------------------------------------------------
SPDX_RAW="$WORKDIR/raw.spdx.json"
syft scan "dir:${PKG_DIR}" --source-name "$PKG_NAME" --source-version "$PKG_VERSION" -o "spdx-json=${SPDX_RAW}"

PKG_COUNT="$(node -e "const s=require(process.argv[1]); process.stdout.write(String((s.packages||[]).length))" "$SPDX_RAW")"
if [[ "$PKG_COUNT" -lt 1 ]]; then
  echo "::error::generated SPDX has an empty packages[] array — refusing to publish an empty SBOM"
  exit 1
fi
echo "SPDX packages[] count: $PKG_COUNT"

# ---------------------------------------------------------------------------
# 4b. Fail closed unless the SBOM actually enumerates what ships. The count
#     check above is necessary but not sufficient: an SBOM generated from a
#     bare, never-installed tarball still has ONE entry (the package's own
#     package.json), so "packages[] >= 1" would wave a dependency-less
#     document through. validate-sbom.mjs (a sibling of this script, so it is
#     always present on the workflow's own ref even when backfilling a tag
#     that predates it) requires a versioned entry for $PKG_NAME@$PKG_VERSION
#     AND for every key of the PUBLISHED package.json's `dependencies`, and
#     lists the missing names on failure. The floor is derived from that
#     manifest, never hardcoded, so it tracks dependency changes on its own.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/validate-sbom.mjs" \
  --sbom "$SPDX_RAW" \
  --manifest "$PKG_DIR/package.json" \
  --name "$PKG_NAME" \
  --version "$PKG_VERSION"

# ---------------------------------------------------------------------------
# 5. Stage the tarball + SBOM into OUT_DIR for the caller to upload as a
#    workflow artifact (the `release` job attaches both to the GitHub
#    Release in the same call — see that job's header comment).
# ---------------------------------------------------------------------------
BASENAME="$(basename "$PKG_NAME")"
ASSET_NAME="${BASENAME}-${PKG_VERSION}.spdx.json"
cp "$SPDX_RAW" "$OUT_DIR/$ASSET_NAME"
cp "$TARBALL_PATH" "$OUT_DIR/$TARBALL"

{
  echo "asset=$ASSET_NAME"
  echo "tarball=$TARBALL"
  echo "package_count=$PKG_COUNT"
} >> "$GITHUB_OUTPUT"
echo "SUPPLY-001: staged $ASSET_NAME and $TARBALL in $OUT_DIR ($PKG_COUNT packages)."
