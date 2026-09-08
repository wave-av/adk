#!/usr/bin/env bash
# SUPPLY-001 (cw #4803) — generate an SPDX SBOM for the REAL PUBLISHED npm
# tarball of a released @wave-av/adk version, and stage it (alongside the
# tarball itself) into OUT_DIR for the caller to upload as a workflow
# artifact / attach to the GitHub Release.
#
# Runs from the `sbom` job in .github/workflows/_release-sbom.yml (a reusable
# workflow chained from release.yml), AFTER that job's "Resolve target tag"
# step has already validated TAG_NAME's shape and the job has checked out
# that exact tag — so `package.json` / `package-lock.json` read below reflect
# the HISTORICAL tag being SBOM'd, not whatever the default branch currently
# is (those can drift on a workflow_dispatch backfill: name/scope/deps change
# over time).
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
#   TAG_NAME  - the exact tag to SBOM (e.g. "v1.0.15"), already validated
#   OUT_DIR   - existing directory to stage the tarball + SBOM asset into
#
# Exits non-zero on any failure. Scoped supply-chain guarantees: the syft
# binary is pinned to an exact version and verified against syft's OWN
# published checksums.txt (fetched from the same immutable GitHub Release,
# over HTTPS) before it is ever executed — no installer script, no floating
# tag/branch ref. Every production dependency pulled into node_modules is
# verified against the SRI integrity hash recorded in the tag's own
# package-lock.json via `npm ci` (falls back to unverified `npm install` only
# when that tag has no lockfile, logged as a warning). The top-level tarball
# itself is fetched over HTTPS from the npm registry by package name + exact
# version (no local checksum pin) — the same trust boundary this workflow's
# `publish` job already relies on (OIDC trusted publishing + `--provenance`).
set -euo pipefail

: "${TAG_NAME:?TAG_NAME required (resolve + validate it before calling this script)}"
: "${OUT_DIR:?OUT_DIR required (existing directory to stage outputs into)}"

if [[ ! "$TAG_NAME" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::TAG_NAME '$TAG_NAME' does not look like a semver tag (expected vX.Y.Z)"
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
PKG_NAME="$(node -p "require('./package.json').name")"
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
#    the top-level artifact. Prefer `npm ci` against the LOCKFILE FROM THIS
#    EXACT TAG (checked out by the caller alongside this script) for exact,
#    reproducible version pins — the same lockfile the `publish` job itself
#    used — rather than re-resolving package.json's semver RANGES against
#    whatever the registry's latest-satisfying versions are today, which
#    would let a later backfill run describe different (newer) dependency
#    versions than the ones consumers actually received for this release.
# ---------------------------------------------------------------------------
echo "resolving production dependencies for the SBOM"
if [[ -f "package-lock.json" ]]; then
  cp "package-lock.json" "$PKG_DIR/package-lock.json"
  ( cd "$PKG_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
else
  echo "::warning title=no lockfile at $TAG_NAME::falling back to npm install against semver ranges — resolved versions may drift from what was originally published"
  ( cd "$PKG_DIR" && npm install --omit=dev --ignore-scripts --no-audit --no-fund )
fi

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
# 4. Generate SPDX JSON for the extracted (published) tarball contents.
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
