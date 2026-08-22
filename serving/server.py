"""
Adapter server — runs a fine-tuned generation locally.

0G returns a LoRA adapter but provides no hosted serving for it, so generations 1+ run
here. Loading LoRA requires transformers + peft, which are Python-only; rather than
reimplement that in Node, the orchestrator treats this as one more brain behind the same
DecideFn interface.

    python3 serving/server.py --adapter runs/gen-1/adapter/output_model --port 8177

Qwen2.5-0.5B on CPU is slow but adequate: the answer is a single token and decisions are
hourly, not high-frequency.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
# The model answers in the wire vocabulary. NONE is a single token; FLAT is FL+AT, which
# biases greedy decoding against it. The domain type stays FLAT; only the word changes.
WIRE_WORDS = ("LONG", "SHORT", "NONE")
FROM_WIRE = {"LONG": "LONG", "SHORT": "SHORT", "NONE": "FLAT"}

SYSTEM_PROMPT = (
    "You are a disciplined systematic trading agent.\n"
    "Given a market snapshot, reply with exactly one word: LONG, SHORT, or NONE.\n"
    "Use LONG if you expect price to rise, SHORT if you expect it to fall,\n"
    "and NONE when neither direction is clearly favoured.\n"
    "Reply with the single word only. No punctuation, no explanation."
)

_state: dict = {}


def parse_action(raw: str):
    """Mirrors the TypeScript parser exactly: exactly one action word, or nothing.

    A reply naming two actions is a refusal to decide, not a decision, and must not be
    silently coerced into FLAT.
    """
    if not raw:
        return None
    found = [w for w in WIRE_WORDS if re.search(rf"\b{w}\b", raw, re.IGNORECASE)]
    return FROM_WIRE[found[0]] if len(found) == 1 else None


def load(adapter_path: str, base_model: str):
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"loading base model {base_model} ...", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    model = AutoModelForCausalLM.from_pretrained(
        base_model, dtype=torch.float32, device_map="cpu"
    )

    print(f"applying adapter {adapter_path} ...", flush=True)
    model = PeftModel.from_pretrained(model, adapter_path)
    model.eval()

    _state["tokenizer"] = tokenizer
    _state["model"] = model
    print("ready", flush=True)


def decide(snapshot_text: str) -> dict:
    import torch

    tokenizer = _state["tokenizer"]
    model = _state["model"]

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"{snapshot_text}\n\nAction:"},
    ]
    prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = tokenizer(prompt, return_tensors="pt")

    started = time.time()
    with torch.no_grad():
        # Greedy: the task has one right answer, and sampling would add variance to a
        # measurement whose whole purpose is comparing generations.
        out = model.generate(
            **inputs,
            max_new_tokens=6,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    raw = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    action = parse_action(raw)
    return {
        "action": action,
        "raw": raw.strip(),
        "parsed": action is not None,
        "latency_ms": int((time.time() - started) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {
                "ok": "model" in _state,
                "generation": _state.get("generation"),
                "adapter": _state.get("adapter"),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/decide":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return

        snapshot = payload.get("snapshot")
        if not isinstance(snapshot, str) or not snapshot:
            self._send(400, {"error": "snapshot (string) is required"})
            return

        try:
            self._send(200, decide(snapshot))
        except Exception as exc:  # surface the real error; a silent FLAT would be worse
            self._send(500, {"error": str(exc)})

    def log_message(self, *_args):
        pass  # the orchestrator logs; per-request noise buries it


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="path to the LoRA adapter directory")
    ap.add_argument("--base-model", default=BASE_MODEL)
    ap.add_argument("--generation", type=int, default=1)
    ap.add_argument("--port", type=int, default=8177)
    ap.add_argument("--selftest", action="store_true", help="one local decision, then exit")
    args = ap.parse_args()

    _state["generation"] = args.generation
    _state["adapter"] = args.adapter

    try:
        load(args.adapter, args.base_model)
    except ImportError as exc:
        print(f"missing dependency: {exc}", file=sys.stderr)
        print("install with: pip install --break-system-packages torch transformers peft",
              file=sys.stderr)
        sys.exit(2)

    if args.selftest:
        sample = (
            "symbol: BTCUSDT  interval: 1h\nclose: 64960.11\nreturn_1b: 0.02%\n"
            "return_6b: 0.17%\nreturn_24b: -0.07%\ndist_from_sma24_in_atr: 0.12\n"
            "rsi_14: 51.0\natr_pct: 0.11%\nvolume_vs_24b_avg: 0.72x\nvol_regime_shift: 0.60x"
        )
        print(json.dumps(decide(sample), indent=2))
        return

    print(f"serving generation {args.generation} on port {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
