# AES-000 Part II — Educational Information Theory (`public/aquin-information.js`)

Quantifies what "informative" means for assessment. Shannon, applied. Node-tested (5).
- **Entropy** H = −Σ p·log2 p — uncertainty about a learner's skill (uniform 3-level
  = 1.585 bits; certain = 0).
- **KL divergence** — how far a belief moved.
- **Expected Information Gain** (Lindley 1956 Bayesian optimal design):
  EIG = H(prior) − E_response[H(posterior|response)]. A DISCRIMINATING question
  (0.35 bits) beats a too-easy/too-hard one (~0.005) — the information-theoretic
  basis of adaptive testing, twin of IRT's Fisher information.
- **selectMostInformative** picks the max-EIG next question; **realizedInfoGain**
  measures bits actually gained; entropy falls with consistent evidence.
Interface: `entropy · klDivergence · posterior · pCorrect · expectedInfoGain ·
selectMostInformative · realizedInfoGain`.
