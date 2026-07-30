---
library: {"id":"gravity-dependencies","title":"Gravity Trade Result Dependencies","kind":"notes","status":"review","tags":["verification","dependency-graph"],"projects":["gravity-trade"],"contains":["dependency-graph"],"related":[]}
---

# Gravity Trade Result Dependencies

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
| `R-OT-FLOW` | Wasserstein gradient flow | [[wo1]] | validated |  | Variational derivative check | Convexity assumptions stated in owner document |
| `R-PROP-2` | Proposition 2 identity | [[p2]] | partial | `R-OT-FLOW` | Algebra checked through displayed identity | Complete the proof and boundary cases |
| `R-OVERVIEW` | Project synthesis | [[ov1]] | unvalidated | `R-PROP-2` | No independent synthesis check yet | Validate Proposition 2 first |
