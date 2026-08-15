"""
LoRA fine-tune of an open-weight chat model on AquinTutor's exported corpus.

RUNS ON A MACHINE YOU OWN, NOT ON THE PLATFORM. Same rule as ml/intent/train.py: no production
database, no cloud pipeline, no secrets. The only input is a .jsonl file exported deliberately by an
administrator from /aquintutor/admin/mind, which has already been whitelisted, PII-scrubbed,
deduplicated and split.

WHY LoRA AND NOT A FULL FINE-TUNE. A full fine-tune of a 7B model needs ~80 GB of optimiser state and
produces a 14 GB artefact that has to be shipped and served whole. LoRA trains two small matrices per
attention projection — tens of millions of parameters instead of billions — so it fits on one 16 GB
card, the artefact is 50-200 MB, and the base model stays exactly what it was. That last part matters
here more than the economics: the platform keeps a base model anybody can obtain and verify, plus a
small adapter of our own, rather than one opaque blob nobody can reason about.

WHY THE MASKING MATTERS. Loss is computed on the ASSISTANT turns only. Train on the whole
conversation and the model spends most of its capacity learning to write the student's questions,
which is not the job. completion_only_loss / DataCollatorForCompletionOnlyLM does that.

Run:
  python ml/lora/train_lora.py --base <hf-model-id> --train train.jsonl --val val.jsonl --out ml/lora/adapters/aquin-001
"""

import argparse
import json
import os
import random
import sys
import time

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from trl import SFTTrainer, DataCollatorForCompletionOnlyLM

SEED = 20260815


def load_jsonl(path):
    """One {"messages":[...]} object per line, exactly what the platform exports."""
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  ! line {i} is not JSON ({e}); skipped")
                continue
            msgs = obj.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2:
                continue
            if msgs[-1].get("role") != "assistant":
                # Nothing to learn from an example that does not end in the thing we are teaching.
                continue
            rows.append({"messages": msgs})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="open-weight base model id or local path")
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--accum", type=int, default=16)
    ap.add_argument("--maxlen", type=int, default=2048)
    ap.add_argument("--no4bit", action="store_true", help="skip 4-bit quantisation (CPU / no bitsandbytes)")
    args = ap.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)

    train_rows = load_jsonl(args.train)
    val_rows = load_jsonl(args.val) if args.val and os.path.exists(args.val) else []
    print(f"train {len(train_rows)}  validation {len(val_rows)}")
    if len(train_rows) < 100:
        # Not a hard stop, but say it plainly: this is the number that decides whether the run is
        # worth the electricity.
        print("\n  !! Under 100 usable examples. A LoRA on this will imitate the corpus's quirks")
        print("     rather than learn its style. The small network in src/lib/mind is the better")
        print("     use of a corpus this size. Continuing because you asked.\n")

    tok = AutoTokenizer.from_pretrained(args.base, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.padding_side = "right"

    quant = None
    if not args.no4bit:
        try:
            from transformers import BitsAndBytesConfig
            quant = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
        except Exception as e:  # noqa: BLE001
            print(f"  ! 4-bit unavailable ({e}); loading in bf16")

    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    if quant is not None:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.config.use_cache = False

    peft_cfg = LoraConfig(
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=args.dropout,
        bias="none",
        task_type="CAUSAL_LM",
        # Attention + MLP projections. Naming differs across families; anything absent is ignored.
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, peft_cfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"trainable {trainable:,} of {total:,}  ({100 * trainable / max(1, total):.3f}%)")

    def render(batch):
        # The base model's OWN chat template. Inventing a format here is the most common way a
        # fine-tune ends up worse than the model it started from.
        return {"text": [tok.apply_chat_template(m, tokenize=False) for m in batch["messages"]]}

    ds_train = Dataset.from_list(train_rows).map(render, batched=True, remove_columns=["messages"])
    ds_val = Dataset.from_list(val_rows).map(render, batched=True, remove_columns=["messages"]) if val_rows else None

    # Loss on the assistant's words only.
    marker = "<|assistant|>"
    for probe in ("<|assistant|>", "[/INST]", "<|im_start|>assistant", "### Assistant:"):
        if probe in (ds_train[0]["text"] if len(ds_train) else ""):
            marker = probe
            break
    print(f"completion marker: {marker!r}")
    collator = DataCollatorForCompletionOnlyLM(response_template=marker, tokenizer=tok)

    targs = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        save_strategy="epoch",
        eval_strategy="epoch" if ds_val is not None else "no",
        bf16=torch.cuda.is_available(),
        gradient_checkpointing=True,
        report_to=[],
        seed=SEED,
    )

    trainer = SFTTrainer(
        model=model,
        args=targs,
        train_dataset=ds_train,
        eval_dataset=ds_val,
        tokenizer=tok,
        max_seq_length=args.maxlen,
        data_collator=collator,
    )

    t0 = time.time()
    trainer.train()
    took = time.time() - t0

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    metrics = {}
    if ds_val is not None:
        metrics = trainer.evaluate()
        print(json.dumps(metrics, indent=2))

    # The card travels WITH the adapter. An adapter whose corpus, base and settings are not recorded
    # is an adapter nobody can compare, roll back to with confidence, or explain to anybody later.
    card = {
        "base": args.base,
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "seconds": round(took, 1),
        "examples": {"train": len(train_rows), "validation": len(val_rows)},
        "lora": {"r": args.rank, "alpha": args.alpha, "dropout": args.dropout,
                 "targets": peft_cfg.target_modules},
        "optim": {"epochs": args.epochs, "lr": args.lr,
                  "effectiveBatch": args.batch * args.accum, "maxLen": args.maxlen,
                  "quantised4bit": quant is not None},
        "seed": SEED,
        "eval": metrics,
        "corpusManifest": "paste aquin-lora-manifest.json checksum here",
        "python": sys.version.split()[0],
        "torch": torch.__version__,
    }
    with open(os.path.join(args.out, "adapter_card.json"), "w", encoding="utf-8") as fh:
        json.dump(card, fh, indent=2)

    print(f"\nadapter written to {args.out}  ({took / 60:.1f} min)")
    print("serve it:  vllm serve <base> --enable-lora --lora-modules aquin=" + args.out)
    print("then point /admin/llm at it, and run 'Evaluate the configured model' on the Mind console.")
    print("If it does not beat the platform's own rules there, it has not learned this platform.")


if __name__ == "__main__":
    main()
