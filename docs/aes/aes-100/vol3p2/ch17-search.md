# AES-100 Vol III P2 Ch 17 — Universal Search & Semantic Retrieval (public/aquin-search.js)

Search by MEANING, not just keywords. Node-tested (5). Named algorithms.
- **Full-text BM25** (Robertson/Sparck-Jones): inverted index, TF saturation, IDF
  weights rare terms, long docs penalised.
- **Vector search**: cosine similarity over embeddings (finds close content with no
  shared words; newton scored 0.24 vs bernoulli 0.9997 for a flow query).
- **Hybrid**: min-max normalise lexical + semantic, fuse α·lex+(1−α)·sem.
- **RAG**: retrieve top-k passages → assemble grounded context (generation is a
  declared LLM substrate; retrieval is real).
Product-relevant: the Aquin assistant/knowledge surfaces can retrieve over this.
HONEST SCOPE: BM25/cosine/fusion/RAG-assembly real; embedding model + generator
declared substrates.
