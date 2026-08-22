# Why the gen-1 LoRA never emits FLAT

**Target:** `/home/kc/Workstation/hack/OG` — Qwen2.5-0.5B-Instruct + gen-1 LoRA adapter,
0 FLAT emissions across 736 decisions.
**Date:** 2026-08-21. All numbers below were produced on this machine; commands and
outputs are inline.

> **Note on repo state.** Partway through this investigation a concurrent process
> refactored the repo from `src/*` into a `services/*` layout; it landed as commit
> `bd97f6f refactor: services-first layout`. I made no writes to the repo. Paths below
> use the **current** layout, with the pre-refactor path noted where it differs.
> Line numbers were re-verified against the post-refactor files:
> `services/agent/src/curriculum.ts` — `toExample()` at 63, `balance()` at 111;
> `services/market/src/indicators.ts` — `RENDERER_VERSION` at 27.

---

## TL;DR

FLAT is absent for **two compounding reasons**, one dominant:

1. **ROOT CAUSE — the fine-tune never learned the task at all.** The adapter cannot
   reproduce the correct label on its *own training examples* after ~12 epochs. The
   trainer packed the 259 examples into **66 sequences of ~512 tokens** and computed
   loss over **every** token, so the answer word was **1.0%** of the training signal.
   The reported loss curve (6.49 → 0.106) is almost entirely the model memorising the
   fixed 121-token snapshot template, not the label. What the adapter actually learned
   is a *prompt-conditioned marginal* over the three words, with no dependence on the
   features.

2. **AMPLIFIER — `FLAT` is a 2-token word (`FL`+`AT`) while `LONG` and `SHORT` are
   single tokens**, and the base model's prior on `FL` under the exact serving prompt is
   **60× lower** than on `SHORT`. The adapter moved FLAT up ~10× but not far enough. In
   that learned marginal FLAT sits at **P=0.140, rank 3**, permanently behind
   LONG (0.431) and SHORT (0.426) — so greedy argmax can never select it, on any input.

A prompt-format mismatch between training and serving is real and measurable, and it is
what pins the marginal at the specific 43/43/14 split — but it is a *contributing* cause,
not the root one. Even with a perfectly matched prompt, a model with 1% of its gradient
on the label would still not have learned the mapping.

---

## The failure, reproduced

`runs/gen-1/traces.jsonl`, 736 decisions:

```
--- gen-0  n=736 ---
 actions : {'LONG': 682, 'SHORT': 54}
 hindsight: {'LONG': (179, '24.32%'), 'FLAT': (354, '48.10%'), 'SHORT': (203, '27.58%')}
 accuracy: 175/736 = 23.78%
--- gen-1  n=736 ---
 actions : {'LONG': 394, 'SHORT': 342}          <-- FLAT: 0
 hindsight: {'LONG': (179, '24.32%'), 'FLAT': (354, '48.10%'), 'SHORT': (203, '27.58%')}
 accuracy: 191/736 = 25.95%
 model: [('gen1-lora', 736)]
```

FLAT is the correct answer 354/736 = **48.10%** of the time in this trace set (the README
quotes 46.33% over a longer window). Refusing to ever emit it caps accuracy at 51.9%
*in the best case* and delivers 25.95% in practice. Note also that gen-1 did **not**
inherit gen-0's LONG bias — it went from 93% LONG to a near-even 53/47 LONG/SHORT split.
That is the fingerprint of a model emitting a learned *marginal*, not a decision.

### The decisive observation: it fails on its own training data

The live server (`curl localhost:8177/health` → `{"ok": true, "generation": 1}`) was asked
to classify five snapshots **taken verbatim from `runs/gen-1/dataset.jsonl`** — examples
the adapter was trained on for ~12 epochs:

```
Live server /decide on 5 FLAT-labelled TRAINING examples:
   expected=FLAT  got='LONG'   raw='LONG'
   expected=FLAT  got='SHORT'  raw='SHORT'
   expected=FLAT  got='SHORT'  raw='SHORT'
   expected=FLAT  got='SHORT'  raw='SHORT'
   expected=FLAT  got='LONG'   raw='LONG'
```

**0/5 on the training set.** A rank-8 LoRA on 259 examples for 12 epochs should overfit
these to near-perfect recall. It has not memorised a single one. Whatever the training
run optimised, it was not "map this snapshot to this word."

---

## Hypothesis-by-hypothesis

### H1 — Is FLAT in the training data at the expected rate? ✅ YES, data is clean

```
$ python3 -c "count labels in runs/gen-1/dataset.jsonl"
label counts: {'FLAT': 86, 'SHORT': 86, 'LONG': 87}
total 259
  FLAT: 86 (33.2%)   SHORT: 86 (33.2%)   LONG: 87 (33.6%)
distinct instructions: 1
```

Matches `runs/gen1-train.log` exactly (`examples 259 {"FLAT":86,"SHORT":86,"LONG":87}`).
`balance()` in `curriculum.ts` did its job. **The dataset is not the problem.**
Every `input` field is exactly **121 tokens** — `renderSnapshot()` emits a fixed
10-line template, so all 259 prompts are token-identical in structure and differ only in
the numerals.

### H6 — Does the tokenizer penalise FLAT? ✅ YES — this is the amplifier

```
  -- bare
     'LONG'   -> [51306]       ['LONG']        (1 tok)
     'SHORT'  -> [87918]       ['SHORT']       (1 tok)
     'FLAT'   -> [6126, 828]   ['FL', 'AT']    (2 tok)   <-- 2 tokens
  -- leading space
     ' LONG'  -> [33942]       (1 tok)
     ' SHORT' -> [64924]       (1 tok)
     ' FLAT'  -> [12772, 828]  [' FL','AT']    (2 tok)
  -- as served ("Action: X")
     'Action: LONG'  -> ['Action', ':', ' LONG']        (3 tok)
     'Action: SHORT' -> ['Action', ':', ' SHORT']       (3 tok)
     'Action: FLAT'  -> ['Action', ':', ' FL', 'AT']    (4 tok)
```

`FLAT` is the only one of the three that is not a single vocabulary item. Two
consequences:

* At the decision position the model must commit to `FL` (id 6126) — a rare subword —
  rather than to a dedicated whole-word token. Its base-model prior there is far lower.
* Under a packed, unmasked LM loss, `AT` after `FL` is free (~P=1.0), so a FLAT example
  contributes *less* usable gradient per example than it appears to, and the two-token
  label makes the class asymmetric with the other two in exactly the direction that
  suppresses it.

This alone would not zero out FLAT — but it sets FLAT's starting handicap, and given how
little the fine-tune moved anything (H4), the handicap survived training.

### H5 — Is the base model's prior against FLAT too strong for r=8? ❌ NO — falsified

This was the cleanest falsification. The base model's preference between the three words
is almost entirely a function of the **prompt format**, not an intrinsic anti-FLAT prior.
Measured on 12 FLAT-labelled examples, next-token distribution, adapter enabled vs
disabled (`model.disable_adapter()`):

| prompt format | BASE argmax | BASE P(FL) | ADAPTER argmax | ADAPTER P(FL) |
|---|---|---|---|---|
| **A — exact `server.py` prompt** (system + `\n\nAction:`) | SHORT 12/12 | 0.0147 | LONG 6 / SHORT 6 | **0.140 (rank 3)** |
| B — same system, no `Action:` suffix | SHORT 12/12 | 0.1193 | LONG 9 / SHORT 3 | 0.164 (rank 3) |
| C — **training `instruction` as system**, no suffix | **FL 12/12** | **0.4939** | SHORT 12/12 | 0.245 (rank 3) |
| F — alpaca `### Instruction / ### Input / ### Response` | **FL 12/12** | **0.7130** | **FL 11/12** | 0.354 (rank 1) |

Read row C and row F. **The un-finetuned base model picks FLAT 12/12 and 12/12** when
prompted with the training-set instruction text. There is no anti-FLAT prior to overcome.

Worse: in both those rows **fine-tuning made FLAT *less* likely** — 0.494 → 0.245 under C,
0.713 → 0.354 under F. The adapter did not learn FLAT; it partially *unlearned* it, while
dragging all three words toward a flat, uninformative marginal.

### H2 — Prompt-format mismatch between training and serving? ✅ YES, and it is measurable

**Serving** (`serving/server.py:75-81`, and the identical TS at
`src/agent/inference.ts:66-71` → now `services/agent/src/inference.ts`):

```python
messages = [
    {"role": "system", "content": SYSTEM_PROMPT},          # 5-line "disciplined systematic trading agent"
    {"role": "user",   "content": f"{snapshot_text}\n\nAction:"},   # <-- "Action:" suffix
]
prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
```

**Training** (`runs/gen-1/dataset.jsonl`), a flat alpaca-style triple:

```json
{"instruction": "You are a trading agent. Given market features, respond with exactly one of LONG, SHORT, or FLAT.",
 "input": "symbol: BTCUSDT  interval: 1h\nclose: 78081.71\n...",
 "output": "FLAT"}
```

Three concrete divergences:

1. **Different system text.** Training instruction is one 23-token line. Serving injects a
   different, 5-line, 62-token system prompt that the model never saw in training.
2. **`\n\nAction:` exists only at serving.** Nothing in `curriculum.ts` `toExample()` appends it. The model is being cued with a token sequence absent from all
   259 training examples.
3. **Chat template vs raw fields.** The remote trainer's wrapper is not the Qwen chat
   template (see H4 below) — serving wraps everything in
   `<|im_start|>system … <|im_end|>\n<|im_start|>user … <|im_end|>\n<|im_start|>assistant\n`.

The cost of divergence #1 and #2 is directly measurable in the table above: moving from
the serving prompt (row A) to the training instruction (row C) raises the *base* model's
P(FLAT) from **0.0147 to 0.4939 — a 33× swing driven purely by prompt text**. Row A is the
single worst of the seven formats tested for FLAT.

### H4 — Did training converge on the label at all? ❌ NO — this is the root cause

`runs/gen-1/adapter/output_model/checkpoint-400/trainer_state.json`:

```
  step   10 epoch   0.308 loss 6.49138
  step   20 epoch   0.615 loss 0.34551
  step   30 epoch   0.923 loss 0.12649     <-- converged by epoch 1
  step   40 epoch   1.215 loss 0.12098
  ...
  step  200 epoch   6.062 loss 0.11488
  step  300 epoch   9.092 loss 0.10898
  step  400 epoch  12.123 loss 0.10635     <-- 370 steps for 0.02 nats
```

Two things fall out of this file.

**(a) The trainer's dataset had ~66 rows, not 259.**
`num_train_epochs: 13`, `max_steps: 400`, `per_device_train_batch_size: 2`. HF sets
`num_train_epochs = ceil(max_steps / steps_per_epoch)`; the reported epoch at step 400
(12.1231 ≈ 400/33) pins `steps_per_epoch = 33`, and it is consistent at every checkpoint:

```
ck200: step=200 epoch=6.0615 -> implied rows N=65.99
ck300: step=300 epoch=9.0923 -> implied rows N=65.99
ck400: step=400 epoch=12.1231 -> implied rows N=65.99
```

66 rows × batch 2 = 33 steps/epoch. **The 259 examples were concatenated and re-chunked
into 66 blocks — a ratio of 3.92:1, i.e. classic causal-LM packing into 512-token blocks.**
Reconstructing which wrapper yields exactly 66 blocks of 512:

```
format                                     total  per-ex  blocks@512
im_start user/assistant, no system         34274   132.3          66  <<< MATCH
### Input/### Response (no instruction)    33756   130.3          65  <<< MATCH
Input/Output labels                        33238   128.3          64
input\n\noutput<eos>                       32202   124.3          62
instruction+input+output plain             37900   146.3          74
alpaca with preamble                       47224   182.3          92
qwen-chat (system+user+assistant)          41526   160.3          81
```

Only two wrappers land in the 65–66 window, and **both of them drop the `instruction`
field**. The 23-token instruction — the only place the label vocabulary "LONG, SHORT, or
FLAT" is ever stated — appears never to have reached the model. Meanwhile serving
prepends a *different* 62-token system prompt.

**(b) The label is ~1% of the loss, so the loss curve says nothing about accuracy.**

```
Implied trained sequence budget per example: 130.5 tokens
Mean label tokens per example: 1.33  (FLAT=2, LONG/SHORT=1)
Label share of an unmasked LM loss: 1.021%

If the label were at pure chance (uniform over 3 actions), its contribution to
the mean per-token loss would be ln(3)/130 = 0.0084
Observed plateau loss (step 40-400): ~0.106-0.121
=> a label at pure chance is worth 7.9% of the plateau: invisible in the curve.

Driving label loss from ln(3) to ~0 improves reported loss by only 0.0084 nats --
comparable to the run-to-run noise already in the log
(step 140=0.11311 vs step 150=0.11590, a swing of 0.0028).
```

This explains the whole shape of the curve. The drop 6.49 → 0.126 in 30 steps is the
model learning the **fixed 121-token snapshot template** — `symbol: BTCUSDT  interval:
1h\nclose: …\nreturn_1b: …` is byte-identical across all 259 examples except the
numerals, so it is trivially memorisable and it is 99% of the tokens. After that the
curve is flat because there is nothing left to learn *that the loss can see*. The
"6.49 → 0.109" convergence that looks like success is a template-memorisation curve with
the actual task buried under it at the noise floor.

There is no per-class loss in `trainer_state.json` (`eval_steps: 500` > `max_steps: 400`,
so no eval ever ran, and `best_metric: None`). The reconstruction above is the recoverable
substitute, and the 0/5 training-set failure is the direct confirmation.

### H3 — Actual next-token ranks where FLAT is correct ✅ measured: FLAT is rank 3, always

The money numbers, on the **exact prompt `server.py` builds**, 12 FLAT-labelled examples:

```
A_serving(server.py)     ADAPTER  argmax_top1={'LONG': 6, 'SHORT': 6}
      LONG     median_rank=     2  mean_prob=0.430541
      SHORT    median_rank=     2  mean_prob=0.425892
      FL       median_rank=     3  mean_prob=0.140103     <-- FLAT, never rank 1
A_serving(server.py)     BASE     argmax_top1={'SHORT': 12}
      LONG     median_rank=     2  mean_prob=0.059214
      SHORT    median_rank=     1  mean_prob=0.916016
      FL       median_rank=     3  mean_prob=0.014732
```

FLAT is **rank 3, on every single example** — not rank 10, not out of distribution.
0.431 + 0.426 + 0.140 = **0.997**: the adapter has learned the *output space* perfectly
(it puts 99.7% of its mass on exactly the three legal words) while learning nothing about
*which* one to pick. LONG and SHORT are tied at ~0.43 on inputs where FLAT is correct.

This is the signature of a learned constant marginal. And it explains the 736-decision
result precisely: with a fixed 43/43/14 distribution and greedy decoding, the argmax
alternates between LONG and SHORT on tiny numeric perturbations and **can never reach
FLAT**, which is exactly what `traces.jsonl` shows (394 LONG / 342 SHORT / 0 FLAT).

Note the adapter *did* move FLAT: 0.0147 → 0.140, roughly +2.3 nats, about a 10× lift.
The training signal was not zero. It was just an order of magnitude too weak to close a
gap that the serving prompt had opened to 60×.

### The clincher: the adapter's output does not depend on the input at all

Constrained 3-way scoring — the full sequences `LONG`, `SHORT`, `FLAT` are scored and
renormalised, so FLAT is **not** penalised for being two tokens. 12 examples of each true
class, serving prompt, adapter on:

```
-- renormalised P(action | snapshot), mean by true class --
true            LONG       SHORT        FLAT
LONG          0.4382      0.4131      0.1487
SHORT         0.4257      0.4235      0.1508
FLAT          0.4320      0.4274      0.1406      <-- P(FLAT) is LOWEST when FLAT is correct

-- confusion, argmax by TOTAL sequence logprob --
  true LONG   -> {'LONG': 8, 'SHORT': 4, 'FLAT': 0}
  true SHORT  -> {'LONG': 6, 'SHORT': 6, 'FLAT': 0}
  true FLAT   -> {'LONG': 6, 'SHORT': 6, 'FLAT': 0}

-- confusion, argmax by LENGTH-NORMALISED logprob --
  true LONG   -> {'LONG': 8, 'SHORT': 4, 'FLAT': 0}
  true SHORT  -> {'LONG': 6, 'SHORT': 5, 'FLAT': 1}
  true FLAT   -> {'LONG': 6, 'SHORT': 6, 'FLAT': 0}

3-way constrained accuracy: total-logprob=38.9%  length-normalised=36.1%  (chance=33.3%, n=36)
```

Read the three rows of that first table. They are **identical to within 0.03**. The
adapter's distribution over the three actions is the same whether the correct answer is
LONG, SHORT, or FLAT. `P(FLAT)` is 0.1487 / 0.1508 / 0.1406 — if anything *marginally
lower* on the examples where FLAT is right. Constrained accuracy is 38.9% against a 33.3%
chance floor, which at n=36 is inside the noise band.

**There is no feature→label signal in this adapter to rescue.** It emits a fixed marginal
of roughly 43% LONG / 43% SHORT / 14% FLAT regardless of what it is shown.

This also rules out the obvious quick fix: **constrained decoding does not help.** Even
with length-normalised scoring over exactly the three legal strings — which fully removes
the tokenisation penalty — FLAT is selected **1 time out of 36**. The deficit is a
learned bias in the marginal, not a decoding artefact.

### Bonus finding: FLAT peaked at step 200 and then got worse

Same measurement across the three saved checkpoints (10 FLAT-labelled examples, serving
prompt):

```
    checkpoint   P(LONG)  P(SHORT)     P(FL)  rank(FL)
 base (step 0)    0.0528    0.9199    0.0173         3
checkpoint-200    0.3907    0.3322    0.2728         3     <-- best calibrated
checkpoint-300    0.4288    0.4327    0.1351         3
checkpoint-400    0.4147    0.4300    0.1518         3     <-- the one that shipped
```

At step 200 the marginal was **0.39 / 0.33 / 0.27** — close to the 1/3 each the balanced
dataset should induce, with FLAT only 1.43× behind LONG. By step 300 FLAT had collapsed to
0.135, a 3.2× gap, and it never recovered. 0G ships the *final* checkpoint, so the run
delivered the worse of the two.

**This falsifies "just train longer" as a fix.** Steps 200→400 actively degraded FLAT. It
also points at the regularisers: `neftune_noise_alpha: 5` (embedding noise) plus
`lora_dropout: 0.1` are fighting a run that needs to *memorise* 259 examples, not
generalise from them.

---

## Ranked causes

| # | Cause | Confidence | Evidence |
|---|---|---|---|
| **1** | **Label is ~1% of an unmasked, packed LM loss — the fine-tune never learned the task** | **High** | 259 examples → 66 packed 512-token blocks (implied N=65.99 at all 3 checkpoints); label = 1.33 of 130.5 tokens = 1.02%; a chance-level label is worth 0.0084 nats vs a 0.106 plateau and 0.0028 step-to-step noise; **0/5 on its own training data**; identical P(action) across all three true classes |
| **2** | **Prompt-format mismatch pins the marginal at its worst point for FLAT** | **High** | Base P(FLAT) swings 0.0147 → 0.4939 → 0.7130 across formats; the serving format is the *worst of seven tested*; serving injects a 67-token system prompt and an `\n\nAction:` suffix that appear in **zero** training examples; the two wrappers that reproduce the observed 66-block count both **drop the `instruction` field entirely** |
| **3** | **`FLAT` is 2 tokens (`FL`+`AT`); `LONG`/`SHORT` are 1** | Medium-High | `tk.encode('FLAT') == [6126, 828]`; asymmetric loss contribution and a rare-subword first token; sets the starting handicap that (1) and (2) then fail to close |
| **4** | **Over-regularised for the goal** — `neftune_noise_alpha: 5`, `lora_dropout: 0.1`, and training past the best checkpoint | Medium | P(FLAT) 0.273 @ ck200 → 0.135 @ ck300 → 0.152 @ ck400 (shipped) |
| ~~5~~ | ~~Base model prior against FLAT too strong for r=8~~ | **Falsified** | Base picks FLAT **12/12** under format C and **12/12** under format F. No anti-FLAT prior exists |
| ~~6~~ | ~~Class imbalance in the dataset~~ | **Falsified** | 86 / 86 / 87, exactly balanced; `balance()` worked |
| ~~7~~ | ~~Greedy decoding / decoding artefact~~ | **Falsified** | Length-normalised constrained scoring over the 3 legal strings still picks FLAT 1/36 |

---

## The fix

### Hard constraint discovered

`docs/SPECIFICATION.md:107` — **"Rigid training config. Keys may not be added or removed,
only values changed."** So `train_on_inputs: false`, a `response_template`, or a
completion-only collator **cannot be added** to `runs/gen-N/config.json`. Cause #1 cannot
be fixed directly. Everything below works *around* it from the dataset side, plus the five
config values that may be changed.

### Fix 0 — free, do it before spending any 0G (confirms cause #2 in ~5 minutes)

The adapter already on disk emits FLAT under a different prompt. Serve it with the alpaca
format and see FLAT appear immediately:

**File:** `serving/server.py`, `decide()` at lines 75–82. Replace the chat-template block with:

```python
    prompt = (
        "### Instruction:\n"
        "You are a trading agent. Given market features, respond with exactly one of "
        "LONG, SHORT, or FLAT.\n\n"
        f"### Input:\n{snapshot_text}\n\n"
        "### Response:\n"
    )
    inputs = tokenizer(prompt, return_tensors="pt")
```

Measured expectation: argmax becomes `FL` on **11/12** FLAT examples (format F above).
Accuracy will *not* improve much — the marginal becomes 0.308/0.334/0.354, i.e. near-random —
but it proves the format sensitivity is real and worth a paid generation. **Do not ship
this as the fix**; it trades one broken marginal for another.

### Fix 1 (primary) — make the training text contain the serving text verbatim

The trainer discards `instruction` and applies its own wrapper. The only way to guarantee
the model trains on the exact token sequence it will be served is to put the **whole
rendered serving prompt inside the `input` field**, so it survives any wrapper.

**File:** `services/agent/src/curriculum.ts` (was `src/agent/curriculum.ts`), `toExample()`
at line 63.

Replace:

```ts
function toExample(trace: Trace): TrainingExample {
  return {
    instruction: INSTRUCTION,
    input: renderSnapshot(trace.snapshot),
    output: trace.outcome.hindsight,
  };
}
```

with:

```ts
/** Byte-identical to serving/server.py SYSTEM_PROMPT and src/agent/inference.ts. */
const SERVING_SYSTEM = [
  'You are a disciplined systematic trading agent.',
  'Given a market snapshot, reply with exactly one word: LONG, SHORT, or NONE.',
  'Use LONG if you expect price to rise, SHORT if you expect it to fall,',
  'and NONE when neither direction is clearly favoured.',
  'Reply with the single word only. No punctuation, no explanation.',
].join('\n');

/** FLAT tokenises as FL+AT; NONE is a single Qwen token, like LONG and SHORT. */
const WIRE: Record<Side, string> = { LONG: 'LONG', SHORT: 'SHORT', FLAT: 'NONE' };

function toExample(trace: Trace): TrainingExample {
  return {
    instruction: INSTRUCTION, // kept for schema compliance; the trainer drops it
    input:
      `<|im_start|>system\n${SERVING_SYSTEM}<|im_end|>\n` +
      `<|im_start|>user\n${renderSnapshot(trace.snapshot)}\n\nAction:<|im_end|>\n` +
      `<|im_start|>assistant\n`,
    output: WIRE[trace.outcome.hindsight],
  };
}
```

**The exact training format that now matches serving**, verified against
`tokenizer.apply_chat_template(..., add_generation_prompt=True)`:

```
<|im_start|>system
You are a disciplined systematic trading agent.
Given a market snapshot, reply with exactly one word: LONG, SHORT, or NONE.
Use LONG if you expect price to rise, SHORT if you expect it to fall,
and NONE when neither direction is clearly favoured.
Reply with the single word only. No punctuation, no explanation.<|im_end|>
<|im_start|>user
symbol: BTCUSDT  interval: 1h
close: 78081.71
return_1b: 0.16%
return_6b: -1.20%
return_24b: -3.21%
dist_from_sma24_in_atr: -3.23
rsi_14: 22.8
atr_pct: 0.35%
volume_vs_24b_avg: 0.82x
vol_regime_shift: 0.98x

Action:<|im_end|>
<|im_start|>assistant
NONE
```

That whole block up to and including `<|im_start|>assistant\n` goes in `input`; `NONE`
(or `LONG` / `SHORT`) goes in `output`. Serving already produces the identical prefix, so
the training and inference token streams agree exactly for the first time.

*Caveat:* if the provider also applies its own chat wrapper, the result is double-wrapped
(`<|im_start|>user\n<|im_start|>system…`). That is ugly but harmless for this purpose —
the exact serving token sequence still appears verbatim, immediately followed by the label,
which is the property that matters. The 66-block reconstruction above indicates the
provider's wrapper is minimal and drops `instruction`, so this is the safer bet than
guessing the wrapper. Note also that this makes examples ~206 tokens instead of 130,
which *lowers* the label's share of the unmasked loss from 1.02% to 0.48% — accept that
trade only alongside Fix 3 and Fix 4, which is why these are prescribed together.

### Fix 2 — rename the FLAT label on the wire (kills cause #3)

`NONE` is one token both bare and space-prefixed (`[45425]` / `[42869]`), matching `LONG`
and `SHORT`. Verified single-token alternatives: `NONE`, `WAIT`, `SKIP`, `PASS`, `OUT`,
`FLT`, `Flat`, `flat`. `HOLD` is **two** tokens bare — do not use it.

The `Side` type, hindsight labelling, scoring and on-chain records all keep saying `FLAT`;
only the wire word changes. Two matching edits:

* `serving/server.py:24` — `ACTIONS = ("LONG", "SHORT", "NONE")`, and in `decide()` map
  `NONE` → `FLAT` before returning, so `adapter.ts` and the trace schema are unchanged.
* `services/agent/src/inference.ts` — same substitution in `SYSTEM_PROMPT` and
  `parseAction`, so gen-0-style prompting stays consistent.

Note `renderSnapshot()` must **not** change: `RENDERER_VERSION` (`services/market/src/indicators.ts:27`) is part
of `configHash` and bumping it breaks comparability (I6). Prompt compaction is therefore
*not* recommended in the same generation as this fix — and measurement shows it would buy
little anyway (label share 1.02% → 1.14%, a 1.12× gain).

### Fix 3 — oversample FLAT past parity (bends the marginal directly)

Balanced 33.2% FLAT in the data produced 14% FLAT at inference — an observed shrinkage of
**2.4×**. To land near a third, feed roughly 2.4× parity.

**File:** `services/agent/src/curriculum.ts`, `balance()` at line 111. Change the cap
from "smallest class" to a weighted target:

```ts
/** FLAT survives training at ~0.42x its dataset share (measured, gen-1), so over-weight it. */
const CLASS_WEIGHT: Record<Side, number> = { LONG: 1, SHORT: 1, FLAT: 2.4 };

function balance(traces: Trace[]): Trace[] {
  const groups = new Map<Side, Trace[]>();
  for (const trace of traces) {
    const group = groups.get(trace.outcome.hindsight);
    if (group) group.push(trace);
    else groups.set(trace.outcome.hindsight, [trace]);
  }
  const smallest = Math.min(
    ...[...groups.entries()].map(([side, g]) => g.length / CLASS_WEIGHT[side]),
  );
  return [...groups.entries()]
    .flatMap(([side, g]) => g.slice(0, Math.round(smallest * CLASS_WEIGHT[side])))
    .sort(byTime);
}
```

This is a deliberate departure from the module's stated rule that balance prevents
always-FLAT collapse. That rule was written for a model that *could* emit FLAT. Guard it
by keeping the always-flat 46.33% baseline in the comparison table — if gen-2 collapses to
always-FLAT it will be visible immediately as accuracy ≈ 48% with zero LONG/SHORT.

### Fix 4 — config values only (no keys added or removed, per the provider's rigid schema)

**File:** `runs/gen-2/config.json`

```json
{
  "neftune_noise_alpha": 0,
  "num_train_epochs": 3,
  "per_device_train_batch_size": 2,
  "learning_rate": 0.0003,
  "max_steps": 200
}
```

* `neftune_noise_alpha: 5 → 0`. Embedding noise is an anti-overfitting regulariser; this
  run needs to memorise 259 examples through a 1%-weight loss channel.
* `max_steps: 400 → 200`. Measured: FLAT was best at step 200 (P=0.273, gap 1.43×) and
  degraded after. 0G ships the final checkpoint, so stopping at the good one is the only
  way to get it.
* `learning_rate: 2e-4 → 3e-4` to compensate for the halved step count.

### Expected outcome and how to falsify it

Fixes 1+2+3 attack the marginal; none of them attack cause #1, which is structural to the
provider's unmasked packed loss. **The honest prediction is that gen-2 will emit FLAT at a
usable rate but will still be close to chance on accuracy**, because a label carrying 1% of
the gradient cannot teach a conditional in 200 steps. That is still strictly better than
gen-1: it converts an unmeasurable failure ("never says FLAT") into a measurable one
("says FLAT, but not at the right times"), and it makes the 46.33% always-flat baseline
reachable rather than mathematically excluded.

The check that settles it: after gen-2, re-run the **training-set recall** probe from this
report (`/decide` on 5–20 rows straight out of `dataset.jsonl`). If the adapter still
cannot reproduce labels it was trained on a dozen times, the provider's loss masking is the
binding constraint and no amount of dataset engineering will fix it — at which point the
options are a different fine-tuning provider, or accepting that the 0G fine-tuning path
cannot learn this task and reporting that as the finding.

---

## Reproduction

Scripts are in `/tmp/flat-diagnosis/`:

| script | what it produces |
|---|---|
| `tok.py` | tokenisation of LONG/SHORT/FLAT; dataset token volume per candidate format |
| `logits.py` | next-token ranks for 7 prompt formats × {base, adapter} |
| `discrim.py` | constrained 3-way scoring, per-true-class confusion |
| `ckpt.py` | P(FLAT) across checkpoint-200/300/400 vs base |

Environment: torch 2.13.0+cpu, transformers 5.15.1, peft 0.20.0, CPU float32, greedy.
Base model `Qwen/Qwen2.5-0.5B-Instruct` from the local HF cache. Adapter server was live
on port 8177 throughout (`{"ok": true, "generation": 1}`).

**No files in the repo were modified by this investigation.**

---

## Verification of Fix 0, run independently 2026-08-22

Fix 0 was executed as a read-only probe against the gen-1 adapter on real snapshots drawn
from `runs/gen-0/traces.jsonl`. `serving/server.py` was not modified. Script:
`/tmp/flat-precheck/probe2.py`.

### First pass, 12 snapshots where FLAT is the correct answer

| format | LONG | SHORT | FLAT | FLAT rate |
|---|---|---|---|---|
| chat template (current serving) | 6 | 6 | 0 | 0% |
| alpaca | 0 | 1 | 11 | **92%** |

11/12, matching the predicted 11/12 exactly. Format sensitivity is real.

### Second pass, 8 snapshots per true class, balanced

| true | format | LONG | SHORT | FLAT | correct |
|---|---|---|---|---|---|
| LONG | chat | 4 | 4 | 0 | 4/8 |
| LONG | alpaca | 0 | 1 | 7 | 0/8 |
| SHORT | chat | 5 | 3 | 0 | 3/8 |
| SHORT | alpaca | 0 | 3 | 5 | 3/8 |
| FLAT | chat | 5 | 3 | 0 | 0/8 |
| FLAT | alpaca | 0 | 1 | 7 | 7/8 |

Overall: chat 7/24 (29%), alpaca 10/24 (42%), chance 33%, always-FLAT on this balanced
sample 8/24 (33%).

### What this settles

The alpaca rows barely move across true classes: 7, 5, 7 FLAT out of 8 regardless of what
the market did. The adapter answers FLAT about 79% of the time under alpaca and 0% under
chat. **That is a second fixed marginal, not input-dependence.** The report's own warning
holds: this trades one broken marginal for another and must not be shipped as the fix.

The apparent jump from 29% to 42% is not skill. Alpaca guesses FLAT constantly and FLAT is
one of three balanced classes here, so the gain is close to what always-FLAT scores anyway.
At n=24 the residual is noise.

Conclusion: cause #2 (format mismatch) is confirmed and large. The root cause, the label
carrying ~1% of the training loss, is untouched by prompting alone and still requires
Fix 1 through Fix 4.
