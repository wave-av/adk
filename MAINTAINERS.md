# MAINTAINERS

Who maintains this repo and how to reach them. CODEOWNERS is the incumbent;
the block below indexes it and refuses `ownership: inline`.
PROBE (tier: probe, E7): `contracts validate --type maintainers-contract` judges it.

```yaml maintainers-contract
version: "0.1"
codeowners: CODEOWNERS
bus_factor_min: 2
escalation: "#maintainers"
ownership: codeowners
```
