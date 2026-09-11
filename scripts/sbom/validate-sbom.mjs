#!/usr/bin/env node
// validate-sbom.mjs -- fail loud unless an SPDX SBOM enumerates this package AND
// every runtime dependency the published manifest declares.
//
// Why this exists: the release SBOM is generated from the INSTALLED dependency
// tree (npm ci --omit=dev against the tag's lockfile) so it describes what a
// consumer's `npm install` actually pulls in. The check this replaces only
// asserted `packages[]` was non-empty -- which an SBOM produced from a bare,
// never-installed tarball satisfies with a single self-describing entry and
// zero dependencies. That is the defect: an SBOM that predates install is a
// claim, not an inventory. This script derives its floor from the published
// package.json itself (the `dependencies` keys), so it tracks the manifest as
// dependencies are added or removed and never needs a hardcoded number.
//
// Plain Node stdlib only (no install, no network) so it can be run locally
// against any SPDX document + package.json pair without pushing a tag:
//
//   node scripts/sbom/validate-sbom.mjs --sbom out.spdx.json \
//       --manifest package/package.json --name @scope/pkg --version 1.2.3
//
// Exit 0 on pass, 1 with a `::error::` line on failure, 2 on unusable inputs.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NO_VERSION = new Set(['', 'NOASSERTION']);

export function parseArgs(argv) {
  const out = { allowNoDependencies: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-no-dependencies') { out.allowNoDependencies = true; continue; }
    const key = { '--sbom': 'sbom', '--manifest': 'manifest', '--name': 'name', '--version': 'version' }[arg];
    if (!key) throw new UsageError(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    out[key] = value;
    i += 1;
  }
  for (const required of ['sbom', 'manifest', 'name', 'version']) {
    if (!out[required]) throw new UsageError(`--${required} is required`);
  }
  return out;
}

export class UsageError extends Error {}
export class ValidationError extends Error {}

/** Names of the runtime dependencies the published manifest declares. */
export function declaredDependencies(manifest) {
  const deps = manifest && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
    ? manifest.dependencies
    : {};
  return Object.keys(deps).sort();
}

/** name -> Set(versions) for every SPDX packages[] entry that carries a real version. */
export function versionedPackages(spdx) {
  const found = new Map();
  for (const pkg of Array.isArray(spdx?.packages) ? spdx.packages : []) {
    const name = typeof pkg?.name === 'string' ? pkg.name : '';
    const version = typeof pkg?.versionInfo === 'string' ? pkg.versionInfo : '';
    if (!name || NO_VERSION.has(version)) continue;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(version);
  }
  return found;
}

/**
 * Validate that `spdx` enumerates `name@version` and every dependency `manifest` declares.
 * Returns a one-line summary on success; throws ValidationError otherwise.
 */
export function validate({ spdx, manifest, name, version, allowNoDependencies = false }) {
  const packages = Array.isArray(spdx?.packages) ? spdx.packages : [];
  if (packages.length === 0) throw new ValidationError('SPDX document has an empty packages[] array');

  const declared = declaredDependencies(manifest);
  if (declared.length === 0 && !allowNoDependencies) {
    throw new ValidationError(
      `${name} declares no runtime dependencies in its published package.json -- refusing to validate ` +
        'against a floor of 0 (pass --allow-no-dependencies if that is genuinely intended)',
    );
  }

  const versioned = versionedPackages(spdx);
  const rootVersions = versioned.get(name);
  if (!rootVersions || !rootVersions.has(version)) {
    const seen = rootVersions ? [...rootVersions].join(', ') : 'none';
    throw new ValidationError(`no versioned entry for the package itself, ${name}@${version} (versions seen: ${seen})`);
  }

  const missing = declared.filter((dep) => !versioned.has(dep));
  const floor = 1 + declared.length;
  const summary =
    `${packages.length} packages[], ${versioned.size} distinct with a real versionInfo; ` +
    `floor ${floor} (${name} + ${declared.length} declared runtime deps${declared.length ? `: ${declared.join(', ')}` : ''})`;
  if (missing.length > 0) {
    throw new ValidationError(
      `${summary}\n::error::sbom: no versioned entry for declared runtime dependency(ies): ${missing.join(', ')} ` +
        '-- syft likely scanned an uninstalled tree',
    );
  }
  if (versioned.size < floor) {
    throw new ValidationError(`${summary}\n::error::sbom: only ${versioned.size} versioned package(s), below the floor of ${floor}`);
  }
  return summary;
}

function readJson(file) {
  const path = resolve(file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err.message}`);
  }
  if (text.length === 0) throw new UsageError(`${path} is empty`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${err.message}`);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const summary = validate({
    spdx: readJson(args.sbom),
    manifest: readJson(args.manifest),
    name: args.name,
    version: args.version,
    allowNoDependencies: args.allowNoDependencies,
  });
  process.stdout.write(`${summary}\nSBOM OK: ${args.name}@${args.version} and every declared runtime dependency are enumerated\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    const code = err instanceof UsageError ? 2 : 1;
    process.stderr.write(`::error::sbom: ${err.message}\n`);
    process.exit(code);
  }
}
