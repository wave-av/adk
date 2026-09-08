# PROVENANCE

How this repo's artifacts are attested and pinned. The attestation workflow
and the lockfile are the incumbents; no attestation and no lockfile are refused.
PROBE (tier: probe, E7): `contracts validate --type provenance-contract` judges it.

```yaml provenance-contract
version: "0.1"
attestation: sigstore
sbom: cyclonedx
lockfile: committed
build: reproducible
```
