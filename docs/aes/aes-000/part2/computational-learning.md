# AES-000 Part II — Computational Learning (`public/aquin-ml.js`)

How the SYSTEM learns a model from data (vs Ch 6, a learner's concept-state change).
Real ML: **logistic regression via SGD** on cross-entropy + L2. Node-tested (5).
- Loss decreases (0.15→0.05); test accuracy 1.0 on separable data; recovers the
  decision boundary's weight signs; calibrated probabilities.
- Educational use: learn P(correct | prior-mastery, difficulty, …). BKT/IRT are
  specific generative models; this is the general discriminative learner behind
  `train()/predict()` (deep nets/trees are other hypothesis classes, same interface).
