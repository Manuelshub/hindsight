# Hindsight

**A trading agent that learns from its own losses — and can prove it.**

Most on-chain AI agents are frozen. They wrap a language model in a prompt, and the model
that makes a decision on day 400 is byte-for-byte the model that made the same mistake on
day 1. Nothing in the loop turns a losing trade into a weight update.

Hindsight closes that loop. It trades on paper, scores every decision against what the
market actually did, keeps the ones it got wrong, and fine-tunes itself on those mistakes.
Each retrained generation is committed on-chain **before** the data it will be judged on
exists.

Built on [0G](https://0g.ai) — the fine-tuning economics that make this loop possible
(~0.024 0G per generation) do not exist on any centralised provider at solo-builder scale.

---

## The problem with "our AI improved"

Any team can claim their agent got better. Nobody can check. Backtests are tuned after the
fact, track records are self-reported, and there is no mechanism by which an honest builder
can prove they *didn't* fit the strategy to the evaluation window.

Hindsight's answer is a sealed commitment.

> Think of predicting football results. Telling someone which teams you'd have picked *after*
> the match proves nothing. Sealing your picks in an envelope and posting it publicly with a
> timestamp *before kickoff* proves everything.

That envelope is a smart contract on 0G mainnet. When a generation finishes training, its
weights, training data, and config are committed by hash at a public block timestamp. It can
then only be graded on market data that closed **after** that moment — enforced in the
contract itself:

```solidity
if (windowStart < generation.sealedAt) revert EvaluationPredatesSeal();
```

Every performance number this project reports is therefore out-of-sample with respect to a
public timestamp that predates the data. Not a promise — a `revert`.

---

## How the loop works

```
   ┌──────────────────┐
   │  market data     │  hourly candles
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  feature engine  │  a snapshot at bar i reads only bars [0..i]
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  decision        │  LONG / SHORT / FLAT      ← 0G Compute (TEE-attested)
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  hindsight       │  what the market actually did next.
   │  scoring         │  costs applied. was the decision right?
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  traces          │  every decision + outcome    ← 0G Storage
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  curriculum      │  the mistakes, class-balanced
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  fine-tuning     │  LoRA on Qwen2.5-0.5B        ← 0G Compute
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  seal            │  commit hashes + timestamp   ← 0G Chain (mainnet)
   └────────┬─────────┘
            ▼
        generation N+1 becomes the decision-maker,
        graded only on data newer than its seal
```

### Hindsight labelling

The learning signal. For each decision, look `horizon` bars ahead:

```
forwardReturn = log(close[i+horizon] / close[i])

correct answer = LONG   if forwardReturn >  threshold
                 SHORT  if forwardReturn < -threshold
                 FLAT   otherwise
```

The training label is always what *would* have been right, never what the model said. The
threshold exists so the agent isn't trained to chase moves smaller than its own trading
costs — a reliable way to manufacture in-sample skill that vanishes out of sample.

---

## Which 0G components, and how

| Component | Network | How it is used | Load-bearing? |
|---|---|---|---|
| **0G Compute — Inference** | Testnet | Generation 0's decisions run on `qwen/qwen2.5-omni-7b` with `TeeML` verifiability. Each response is verified via `processResponse` against the provider's TEE signature, so decisions are attested rather than self-reported. | Yes — attestation is what makes the decision record trustworthy |
| **0G Compute — Fine-tuning** | Testnet | Each generation trains a LoRA adapter on Qwen2.5-0.5B-Instruct from the agent's own mistakes, inside a Phala `dstack` TEE. | Yes — this *is* the project |
| **0G Storage** | Testnet | Decision traces, training datasets, and LoRA adapters. Content-addressed by Merkle root; those roots are what gets committed on-chain. | Yes — the roots are the commitment |
| **0G Chain** | **Mainnet** | `LineageRegistry` holds each generation's commitment and its out-of-sample results, and enforces that evaluation windows begin at or after the seal. | Yes — the sealed-evaluation guarantee lives here |

Compute and Storage run on Galileo testnet; the trust anchor is on mainnet. The loop runs
constantly and shouldn't burn real tokens, but the commitment must be permanent.

### Cost

Measured live, not estimated:

| | cost |
|---|---|
| One inference decision (~330 in / 20 out tokens) | 0.00045 0G |
| Fine-tuning, 100 examples × 3 epochs | 0.058 0G |
| Fine-tuning, 250 examples × 3 epochs | 0.130 0G |
| Running generation 1+ (local adapter) | free |

Counter-intuitively, **thinking costs more than learning** here — inference is ~5× the price
per token of fine-tuning. Once the agent is running its own adapter locally, decisions are
free and only training touches the ledger.

---

## Layout

Services-first. Each service owns its code, tests, and README, and can be worked on
without touching another.

    schemas/              domain types shared across services
    config/               network endpoints, provider addresses, env loading
    services/
      market/             candles, features, prompt rendering
      agent/              brains (baseline, remote, adapter) + curriculum
      scoring/            hindsight labelling, stats, sealed evaluation
      storage/            trace persistence + 0G Storage
      training/           fine-tuning state machine
      lineage/            on-chain commitment client
    contracts/            Solidity (Foundry)
    serving/              Python LoRA adapter server
    cli/                  glue only, no business logic

## Setup

Requirements: Node ≥ 20, pnpm, Python 3.10+ (for adapter serving), [Foundry](https://getfoundry.sh)
(for contracts).

```bash
git clone --recursive <repo-url>
cd hindsight
pnpm install

cp .env.example .env
# add a THROWAWAY private key — never one holding real funds
```

Contracts:

```bash
cd contracts
forge install foundry-rs/forge-std   # if you didn't clone with --recursive
forge test
```

### Getting testnet funds

Fine-tuning and inference draw from a 0G Compute ledger with a **3 0G minimum deposit**.
The [faucet](https://faucet.0g.ai) gives 0.1 0G/day, so request a larger grant in the 0G
Discord if you plan to run multiple generations.

---

## Usage

```bash
# what's live on 0G right now — services, providers, TEE attestation
pnpm probe testnet

# live pricing and a projected cost for a full run
pnpm costs

# operator wallet address and balances
pnpm wallet

# run a deterministic baseline over real market data
pnpm backtest momentum BTCUSDT 1h 3000

# operator dashboard: ledger, trainer occupancy, forfeit clocks
pnpm status
```

Run the test suite:

```bash
pnpm test            # TypeScript, 74 gate tests
pnpm test:contracts  # Solidity, 20 tests
```

---

## Results so far

Baselines over 3,000 hourly BTCUSDT candles. Every generation is measured against these:

| strategy | accuracy | cumulative return | Sharpe |
|---|---|---|---|
| always-flat | **46.33%** | 0.00% | 0.00 |
| mean-reversion | 42.12% | -9.87% | -0.73 |
| momentum | 33.87% | -76.99% | -6.45 |

**46.33% is the number to beat on this window.** Doing nothing is the hardest baseline
here, because FLAT is the correct answer 48% of the time in this period.

That figure is regime-dependent and must never be hardcoded as a universal comparator.
Measured on a held-out Jan to Apr 2026 window, always-flat scores **33.80%**, because that
regime is far more directional. Any evaluation recomputes the always-flat control from the
same bars the brain was judged on, rather than comparing against a number from a different
period.

### Generations

Same 736-decision window, Apr 12 to Aug 15.

| | gen 0 (7B remote) | gen 1 (0.5B LoRA) |
|---|---|---|
| accuracy | 23.78% | 25.95% |
| cumulative | -51.94% | -41.04% |
| Sharpe | -10.07 | -7.25 |
| max drawdown | 54.78% | 42.13% |
| parse failures | 0.00% | 0.00% |
| actions | L:682 S:54 F:0 | L:394 S:342 F:0 |

The action row is the result. Generation 0 answered LONG 93% of the time. Generation 1
answers LONG 54%. Training on its own hindsight-labelled mistakes measurably corrected a
directional bias.

**These numbers are in-sample and are not evidence of improvement.** Generation 1 trained
on generation 0's mistakes drawn from this same window, so it has effectively seen the
evaluation data. That is precisely the curve-fitting the sealed evaluation exists to rule
out, and nothing here may be reported as improvement until it is re-run on post-seal data.

**Generation 1 still never emits FLAT.** Zero times in 736 decisions, despite 86 FLAT
examples in a balanced 259-example training set. FLAT is right 48% of the time, so the
largest single source of error is untouched and both generations sit far below the
always-flat baseline. Root-cause work is open.

---

## Honest limitations

- **Paper trading only.** No capital, no exchange keys, no order routing. The question being
  answered is "does it learn?", not "does it get rich?"
- **Generation 0 is not a like-for-like ancestor of generation 1.** Gen 0 runs on a 7B model;
  only Qwen2.5-0.5B can be fine-tuned on 0G, so gen 1 onward is a smaller model. The
  improvement claim is therefore made *within* the 0.5B lineage (gen 1 → gen N), never by
  comparing gen 1 to gen 0.
- **A 0.5B model may lack the capacity to learn this task.** That is the central technical
  risk and it is instrumented rather than hidden — a negative result will be published.
- **Adapters are served locally.** 0G provides no hosted serving for your own fine-tuned
  weights; serving them on-network means registering as a Compute provider, which is planned
  but not yet done.
- **Overlapping evaluation horizons** make consecutive returns correlated, so the Sharpe
  figure is a comparison metric between generations, not a tradeable number.

---

## Roadmap

- **Now** — full loop: gen 0 → traces → curriculum → fine-tune → gen 1 → sealed comparison
- **Next** — parallel lineages with different curricula, competing head-to-head; serve
  Hindsight's own adapters as a 0G Compute provider
- **Later** — adapters as transferable assets; a public leaderboard of sealed records

---

## Licence

MIT
