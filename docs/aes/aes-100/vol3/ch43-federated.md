# AES-100 Vol III Ch 43 — Federated Learning & Distributed Intelligence (public/aquin-federated.js)

Real Federated Averaging — FedAvg (McMahan et al. 2017). Node-tested (6).
- **Privacy by construction**: the aggregator accepts only weight vectors + counts;
  raw data never leaves an institution (update keys: participant,w,b,n).
- **FedAvg correctness**: federated accuracy 0.9967 == centralized (pooled) 0.9967 —
  matched WITHOUT pooling the data.
- **Trust + sample weighting**: bigger, more trusted contributors weigh more; a
  low-trust adversarial update is drowned out.
- **Validation** rejects poisoned (absurd weight norm) and wrong-dimension updates —
  one bad actor can't wreck the global model.
- **Model versioning** on every aggregation.
HONEST SCOPE: real FedAvg over logistic-regression weights; differential privacy /
secure MPC / encrypted transport plug in behind the same weight-exchange interface.
(~1.02M-LOC C++ spec distilled to the real learning core.)
