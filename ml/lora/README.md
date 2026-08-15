# ml/lora — fine-tuning an open-weight model on what AquinTutor has actually taught

This is the second training program in this repository. The first, `ml/intent`, is a full fine-tune
of a 66M encoder on a synthetic corpus; it establishes how training is done here — **on a machine
you own, outside the deployment, with the corpus exported deliberately** — and this follows it
exactly.

## Read this before spending anything

**The platform cannot train this itself, and never will.** It runs as serverless functions with a
~10s ceiling, no GPU, no Python, and no model weights in the bundle. `ml/intent/serve.py` says the
same thing about a 257 MB checkpoint: it "cannot live inside a serverless function". So the loop is:

```
export here  →  train on a GPU you rent or own  →  serve from a box you control
             →  come back and PROVE it is better, on this platform's own held-out turns
```

**Do the cheap thing first.** A LoRA is the expensive answer to "make the platform smarter", and it
is rarely the best one:

| | what it costs | what it buys |
|---|---|---|
| Turn on the **pretrained embedding encoder** (`/aquintutor/admin/mind`) | a small always-on CPU box, no GPU, no new code | the platform's own network starts reading *meaning* instead of characters — genuine transfer learning |
| **Distil** into the small network (`src/lib/mind/distill.ts`) | nothing; runs inside a normal request | routing and difficulty prediction that answer in microseconds, offline, forever |
| **LoRA** on a 7–8B base | single-digit GPU-hours to train (cheap) — then an always-on GPU to *serve* (not cheap) | a tutor that writes in this platform's voice and habits |

The training run is the cheap part. **Serving is the commitment**: a 7B model has to be up whenever a
learner types. Do not start this until the gateway carries enough real traffic to justify a GPU that
never sleeps, and until `evaluateConfiguredModel()` on the Mind console shows the model you have now
losing to the platform's own rules.

## Step 1 — export the corpus

From `/aquintutor/admin/mind`, **Export the fine-tuning corpus**. You get:

* `aquin-lora-train.jsonl` and `aquin-lora-val.jsonl` — `{"messages":[…]}` per line, the shape
  axolotl, trl and llama-factory all read
* `aquin-lora-manifest.json` — counts, sources, what was rejected and why, and a checksum

The export is **curated**, which the older `/api/admin/llm?export=jsonl` is not: whitelisted capture
sites only, personal detail scrubbed, exchanges that gave away an answer dropped, near-duplicates
removed, and a deterministic train/validation split so two runs are comparable.

Read the manifest before you train. If it says under a few hundred usable examples, stop — a LoRA on
that will imitate the corpus's quirks, and the small network in `src/lib/mind` is the better use of
it.

## Step 2 — train

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r ml/lora/requirements.txt

python ml/lora/train_lora.py \
  --base mistralai/Mistral-7B-Instruct-v0.3 \
  --train aquin-lora-train.jsonl \
  --val   aquin-lora-val.jsonl \
  --out   ml/lora/adapters/aquin-tutor-001
```

Defaults are QLoRA (4-bit base, rank 16, alpha 32) so this fits on a single 16 GB card. Everything
is pinned in `requirements.txt` for one reason: **a run you cannot reproduce cannot be compared to
the next one**, and comparing runs is the entire point of doing this twice.

The adapter is ~50–200 MB. `ml/*/adapters/` is gitignored, exactly as `ml/*/model/` is — weights do
not go in the repo, and they must never reach the Vercel bundle.

## Step 3 — serve

Any OpenAI-compatible server works, because that is what the gateway already speaks:

```bash
vllm serve mistralai/Mistral-7B-Instruct-v0.3 \
  --enable-lora --lora-modules aquin=ml/lora/adapters/aquin-tutor-001 \
  --port 8000
```

Then in **/admin/llm**: provider `own`, base URL `http://your-host:8000/v1`, model `aquin`. No code
changes. The same box can serve `/v1/embeddings` for the Mind encoder.

## Step 4 — prove it

Back on `/aquintutor/admin/mind`, run **Evaluate the configured model**. It scores whatever the
gateway now points at against the platform's own deterministic rules, on tutor turns a teacher model
or a person labelled independently.

If the fine-tune does not beat the rules on this platform's own taxonomy, it has not learned this
platform, and no amount of it sounding right changes that. That is the same standard the small
network is held to: a model serves because it measured better, not because it is new.

## What must not go in

* No wellness, consult, health, HR or legal-hold text. The exporter uses a **whitelist** of capture
  sites so a new one cannot leak in by default.
* No face images, no ID documents, no biometric templates — the only images this platform holds are
  exactly the ones its privacy rules exist to protect. There is no image training set here and there
  should not be one.
* Check the terms of whichever provider generated the completions you are training on. Most of this
  corpus is a commercial model's output, and distilling it may not be permitted.
