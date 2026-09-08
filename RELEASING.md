# RELEASING

How this repo cuts a release: versioning, changelog, signing, tags. The
release WORKFLOW is the incumbent; this block declares the posture and refuses
`signing: none` and `changelog: none` by name.
PROBE (tier: probe, E7): `contracts validate --type releasing-contract` judges it.

```yaml releasing-contract
version: "0.1"
versioning: semver
changelog: conventional-commits
signing: sigstore
tags: annotated
```
