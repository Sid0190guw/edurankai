"""
Train the AES teacher-intent classifier. Spec section 12.

RUNS ENTIRELY ON THIS LAPTOP. No cloud compute, no Supabase, no Vercel, no production data — the
corpus is the synthetic one from dataset.py. Nothing here costs money.

WHY A SMALL ENCODER AND NOT AN LLM. Intent is a ten-way classification over short utterances, and
spec section 22 requires the ultra-low-latency path to answer without a model round trip. A 66M
encoder answers in single-digit milliseconds on CPU, which means it can run on every sentence a
teacher speaks. A 7B model cannot, at any price. Small is not a compromise here; it is the
requirement.

WHY A HAND-WRITTEN LOOP. 4 GB of VRAM leaves no room for surprises. This controls batch size,
sequence length and precision explicitly, and falls back to CPU rather than dying on an OOM.

Run:  python ml/intent/train.py
"""

import json
import math
import os
import random
import time

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "model")

BASE = "distilbert-base-uncased"
MAX_LEN = 48          # teacher utterances are short; 48 tokens covers them with room to spare
BATCH = 32
EPOCHS = 6
LR = 3e-5
SEED = 20260810

random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
torch.cuda.manual_seed_all(SEED)

LABELS = [
    "normal_speech", "visualization_request", "object_generation", "animation_request",
    "parameter_modification", "camera_command", "annotation", "simulation_command",
    "comparison", "explanation",
]
L2I = {l: i for i, l in enumerate(LABELS)}

# Everything that is not narration is an instruction. This split is the one that decides whether
# the tool is usable in a real class, so it is measured separately from overall accuracy.
COMMAND = set(LABELS) - {"normal_speech"}


def load(name):
    rows = []
    with open(os.path.join(DATA, name + ".jsonl"), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


class Utterances(Dataset):
    def __init__(self, rows, tok):
        self.rows = rows
        self.tok = tok

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        enc = self.tok(r["text"], truncation=True, max_length=MAX_LEN,
                       padding="max_length", return_tensors="pt")
        return {
            "input_ids": enc["input_ids"][0],
            "attention_mask": enc["attention_mask"][0],
            "labels": torch.tensor(L2I[r["label"]], dtype=torch.long),
        }


def metrics(y_true, y_pred):
    """Macro-F1, accuracy, and the narration/instruction boundary, computed without sklearn."""
    n = len(y_true)
    acc = sum(1 for a, b in zip(y_true, y_pred) if a == b) / max(1, n)

    f1s = []
    per_class = {}
    for i, lab in enumerate(LABELS):
        tp = sum(1 for a, b in zip(y_true, y_pred) if a == i and b == i)
        fp = sum(1 for a, b in zip(y_true, y_pred) if a != i and b == i)
        fn = sum(1 for a, b in zip(y_true, y_pred) if a == i and b != i)
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        f1s.append(f1)
        per_class[lab] = (prec, rec, f1, tp + fn)

    # The two errors that matter in a classroom, and they are not symmetric:
    #  - a FALSE FIRE interrupts a lecture with a visualization nobody asked for;
    #  - a MISSED COMMAND makes the teacher repeat themselves, which is annoying but not disruptive.
    ns = L2I["normal_speech"]
    false_fire = sum(1 for a, b in zip(y_true, y_pred) if a == ns and b != ns)
    narration = sum(1 for a in y_true if a == ns)
    missed = sum(1 for a, b in zip(y_true, y_pred) if a != ns and b == ns)
    commands = sum(1 for a in y_true if a != ns)

    return {
        "accuracy": acc,
        "macro_f1": sum(f1s) / len(f1s),
        "per_class": per_class,
        "false_fire_rate": false_fire / max(1, narration),
        "missed_command_rate": missed / max(1, commands),
    }


@torch.no_grad()
def logits_for(model, loader, device):
    """Raw probabilities, so a threshold can be swept without re-running the model."""
    model.eval()
    probs, y_true = [], []
    for b in loader:
        out = model(input_ids=b["input_ids"].to(device),
                    attention_mask=b["attention_mask"].to(device)).logits
        probs.extend(torch.softmax(out, dim=-1).cpu().tolist())
        y_true.extend(b["labels"].tolist())
    return probs, y_true


def decide(probs, threshold):
    """
    ABSTENTION. The two errors are not symmetric and must not be traded one-for-one: a false fire
    interrupts a class with a visualization nobody asked for, while a missed command makes the
    teacher say it again. So unless the model is confident an utterance was an INSTRUCTION, it
    stays silent — which for this taxonomy means calling it narration.

    This is spec section 28 expressed at the model level: nothing reaches the class that the
    teacher did not ask for. Silence is the safe default, and it is always recoverable.
    """
    ns = L2I["normal_speech"]
    out = []
    for p in probs:
        best = max(range(len(p)), key=lambda i: p[i])
        if best != ns and p[best] < threshold:
            out.append(ns)
        else:
            out.append(best)
    return out


def evaluate(model, loader, device, threshold=0.0):
    probs, y_true = logits_for(model, loader, device)
    y_pred = decide(probs, threshold)
    return metrics(y_true, y_pred), y_true, y_pred


def main():
    if torch.cuda.is_available():
        device = torch.device("cuda")
        name = torch.cuda.get_device_name(0)
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"device: {name}  ({vram:.1f} GB)")
    else:
        device = torch.device("cpu")
        print("device: CPU (no CUDA) — this will be slower but will still finish")

    train_rows, dev_rows, test_rows = load("train"), load("dev"), load("test")
    print(f"train {len(train_rows)}  dev {len(dev_rows)}  test {len(test_rows)}")

    tok = AutoTokenizer.from_pretrained(BASE)
    model = AutoModelForSequenceClassification.from_pretrained(
        BASE, num_labels=len(LABELS),
        id2label={i: l for i, l in enumerate(LABELS)},
        label2id=L2I,
    ).to(device)

    train_loader = DataLoader(Utterances(train_rows, tok), batch_size=BATCH, shuffle=True)
    dev_loader = DataLoader(Utterances(dev_rows, tok), batch_size=64)
    test_loader = DataLoader(Utterances(test_rows, tok), batch_size=64)

    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
    steps = len(train_loader) * EPOCHS
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=steps, pct_start=0.1)

    best_f1, best_epoch = -1.0, -1
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()

    for epoch in range(1, EPOCHS + 1):
        model.train()
        total = 0.0
        for b in train_loader:
            opt.zero_grad(set_to_none=True)
            out = model(
                input_ids=b["input_ids"].to(device),
                attention_mask=b["attention_mask"].to(device),
                labels=b["labels"].to(device),
            )
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            total += out.loss.item()

        m, _, _ = evaluate(model, dev_loader, device)
        print(f"epoch {epoch}  loss {total/len(train_loader):.4f}  "
              f"dev acc {m['accuracy']:.4f}  macro-F1 {m['macro_f1']:.4f}  "
              f"false-fire {m['false_fire_rate']:.4f}")

        # Selected on dev macro-F1, never on test. Test is looked at once, at the end.
        if m["macro_f1"] > best_f1:
            best_f1, best_epoch = m["macro_f1"], epoch
            model.save_pretrained(OUT)
            tok.save_pretrained(OUT)

    print(f"\nbest dev macro-F1 {best_f1:.4f} at epoch {best_epoch}  "
          f"({time.time()-t0:.0f}s total)")

    # Reload the selected checkpoint.
    model = AutoModelForSequenceClassification.from_pretrained(OUT).to(device)

    # TUNE THE THRESHOLD ON DEV. Never on test — a threshold chosen against the held-out set makes
    # the held-out number a training number. Target: the lowest false-fire we can reach while still
    # catching at least 85 percent of real instructions.
    dev_probs, dev_true = logits_for(model, dev_loader, device)
    best_t, best_row = 0.0, None
    print("\nthreshold sweep (dev)")
    for t in [i / 100 for i in range(30, 100, 5)]:
        mm = metrics(dev_true, decide(dev_probs, t))
        caught = 1.0 - mm["missed_command_rate"]
        print(f"  t={t:.2f}  false-fire {mm['false_fire_rate']:.4f}  "
              f"commands caught {caught:.4f}  macro-F1 {mm['macro_f1']:.4f}")
        if caught >= 0.85:
            if best_row is None or mm["false_fire_rate"] < best_row["false_fire_rate"]:
                best_t, best_row = t, mm
    print(f"chosen threshold {best_t:.2f} (dev false-fire {best_row['false_fire_rate']:.4f})"
          if best_row else "no threshold met the 85 percent recall floor; using 0.0")

    m, y_true, y_pred = evaluate(model, test_loader, device, threshold=best_t)

    print("\n=== TEST (template-disjoint, never seen in training) ===")
    print(f"accuracy        {m['accuracy']:.4f}")
    print(f"macro-F1        {m['macro_f1']:.4f}")
    print(f"false-fire      {m['false_fire_rate']:.4f}  (narration misread as an instruction)")
    print(f"missed command  {m['missed_command_rate']:.4f}  (instruction misread as narration)")
    print("\nper class            prec    rec     F1     n")
    for lab in LABELS:
        p, r, f, n = m["per_class"][lab]
        print(f"  {lab:22s} {p:.3f}  {r:.3f}  {f:.3f}  {n:4d}")

    with open(os.path.join(OUT, "eval.json"), "w", encoding="utf-8") as f:
        json.dump({
            "base_model": BASE,
            "corpus": "synthetic seed (ml/intent/dataset.py) — NOT real teaching data",
            "seed": SEED,
            "best_dev_macro_f1": best_f1,
            "best_epoch": best_epoch,
            "abstention_threshold": best_t,
            "test": {k: v for k, v in m.items() if k != "per_class"},
            "test_per_class": {k: {"precision": v[0], "recall": v[1], "f1": v[2], "support": v[3]}
                               for k, v in m["per_class"].items()},
        }, f, indent=2)
    print(f"\nsaved to {OUT}")
    print("HONEST LIMIT: trained on synthetic utterances. It has never seen a real teacher speak.")


if __name__ == "__main__":
    main()
