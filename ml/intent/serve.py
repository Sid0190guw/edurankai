"""
Local inference server for the AES teacher-intent classifier.

WHERE THIS RUNS, AND WHY. Spec section 23 puts speech and real-time model inference at the EDGE,
not in the cloud, and section 22 requires the ultra-low-latency path to answer without a round trip
to a large model. A 257 MB checkpoint also cannot ship inside a serverless function, and the founder
has been explicit that nothing may run on metered cloud compute. So this serves on the teacher's own
machine, and the platform treats it as an OPTIONAL provider that may simply be absent.

Absent is a first-class answer. When this is not running, AES falls back to the deterministic
rule-based route in src/lib/aes/intent.ts and says so on the console. It never guesses.

Stdlib only — no FastAPI, no uvicorn, nothing to install beyond what training already needed.

Run:  python ml/intent/serve.py            (defaults to 127.0.0.1:8577)
      python ml/intent/serve.py --port 9000

Endpoints:
  GET  /health      -> {ok, model, device, labels, loaded_at}
  POST /classify    -> {text: "..."} or {texts: [...]}
                    -> {results: [{intent, confidence, abstained, scores}]}
"""

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "model")

# The platform's IntentKind vocabulary (src/lib/aes/intent.ts) is shorter than the training label
# names. Map here, once, so the wire format is the platform's and never the trainer's. A mismatch
# between these two vocabularies would be silent and would surface as an intent that routes nowhere.
TO_PLATFORM = {
    "normal_speech": "speech",
    "visualization_request": "visualize",
    "object_generation": "object",
    "animation_request": "animate",
    "parameter_modification": "parameter",
    "camera_command": "camera",
    "annotation": "annotate",
    "simulation_command": "simulate",
    "comparison": "compare",
    "explanation": "explain",
}

# Abstention. Below this confidence an INSTRUCTION is downgraded to speech, because a false fire
# interrupts a class and a missed command merely makes the teacher repeat themselves. Read from
# eval.json when the trainer chose one; the default is deliberately conservative.
DEFAULT_THRESHOLD = 0.45

STATE = {"model": None, "tok": None, "device": None, "labels": [], "threshold": DEFAULT_THRESHOLD,
         "loaded_at": None, "base": None}


def load():
    if not os.path.isdir(MODEL_DIR):
        print(f"No model at {MODEL_DIR}. Run:  python ml/intent/train.py", file=sys.stderr)
        sys.exit(2)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    tok = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR).to(device).eval()

    labels = [model.config.id2label[i] for i in range(len(model.config.id2label))]

    threshold = DEFAULT_THRESHOLD
    ev = os.path.join(MODEL_DIR, "eval.json")
    if os.path.exists(ev):
        try:
            with open(ev, encoding="utf-8") as f:
                t = json.load(f).get("abstention_threshold")
            # 0.0 means the sweep found no threshold clearing its recall floor and left abstention
            # off. That is a finding, not a value to adopt: keep the conservative default.
            if isinstance(t, (int, float)) and t > 0:
                threshold = float(t)
        except Exception as e:
            print(f"could not read eval.json ({e}); using default threshold", file=sys.stderr)

    STATE.update(model=model, tok=tok, device=device, labels=labels, threshold=threshold,
                 loaded_at=time.strftime("%Y-%m-%dT%H:%M:%S"), base=MODEL_DIR)
    print(f"loaded {len(labels)} labels on {device}, abstention threshold {threshold:.2f}")


@torch.no_grad()
def classify(texts):
    tok, model, device = STATE["tok"], STATE["model"], STATE["device"]
    enc = tok(texts, truncation=True, max_length=48, padding=True, return_tensors="pt").to(device)
    probs = torch.softmax(model(**enc).logits, dim=-1).cpu()

    out = []
    for row in probs.tolist():
        best = max(range(len(row)), key=lambda i: row[i])
        raw = STATE["labels"][best]
        conf = row[best]
        abstained = raw != "normal_speech" and conf < STATE["threshold"]
        intent = "speech" if abstained else TO_PLATFORM.get(raw, "speech")
        out.append({
            "intent": intent,
            "confidence": round(conf, 4),
            "abstained": abstained,
            # Every score, so the console can show WHY — spec section 66 wants the evidence, not a
            # bare number, and a teacher deciding whether to trust this deserves to see the runner-up.
            "scores": {TO_PLATFORM.get(STATE["labels"][i], STATE["labels"][i]): round(p, 4)
                       for i, p in enumerate(row)},
        })
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Local only: the platform dev server is a different origin on the same machine.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {
                "ok": True,
                "model": "distilbert intent classifier (in-house)",
                "device": str(STATE["device"]),
                "labels": [TO_PLATFORM.get(l, l) for l in STATE["labels"]],
                "threshold": STATE["threshold"],
                "loaded_at": STATE["loaded_at"],
                "corpus": "synthetic seed — has never seen a real teacher speak",
            })
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/classify":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            texts = body.get("texts") or ([body["text"]] if body.get("text") else [])
            if not texts:
                self._send(400, {"ok": False, "error": "give text or texts"})
                return
            if len(texts) > 64:
                self._send(400, {"ok": False, "error": "at most 64 utterances per request"})
                return
            t0 = time.time()
            results = classify([str(t) for t in texts])
            self._send(200, {"ok": True, "results": results,
                             "latency_ms": round((time.time() - t0) * 1000, 1)})
        except Exception as e:
            # Never swallowed and never dressed up as a result: a caller must be able to tell a
            # failure from a confident "this was just narration".
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def log_message(self, *a):
        pass  # the default logger writes a line per request to stderr; too noisy for a live class


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")   # loopback only, deliberately
    ap.add_argument("--port", type=int, default=8577)
    args = ap.parse_args()

    load()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"intent server on http://{args.host}:{args.port}  (ctrl-c to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
