/**
 * Dumps live pricing for every 0G Compute service and projects what a Hindsight run costs.
 *
 *   node_modules/.bin/tsx scripts/costs.ts
 */
import * as sdk from '@0gfoundation/0g-compute-ts-sdk';

const RPC = 'https://evmrpc-testnet.0g.ai';
const WEI = 1e18;

/** Prices come back as bigint wei; normalise to 0G for readability. */
function toOG(v: unknown): number {
  if (v === undefined || v === null) return NaN;
  try {
    return Number(BigInt(v as bigint | string)) / WEI;
  } catch {
    return NaN;
  }
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return 'n/a';
  if (n === 0) return '0';
  if (n < 1e-6) return n.toExponential(2);
  return n.toFixed(8);
}

async function main() {
  const factory = (sdk as any).createZGComputeNetworkReadOnlyBroker;
  const broker = await factory(RPC);

  console.log('\n=== INFERENCE SERVICES (raw fields) ===');
  const inf = await broker.inference.listService();
  for (const s of inf) {
    console.log(`\n${s.model ?? '?'}  [${s.serviceType ?? '?'}]  ${s.provider}`);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'bigint' || /price|fee/i.test(k)) {
        console.log(`   ${k.padEnd(22)} ${String(v).padEnd(24)} ${fmt(toOG(v))} 0G`);
      }
    }
  }

  console.log('\n=== FINE-TUNING SERVICES ===');
  const ft = await broker.fineTuning.listService();
  for (const s of ft) {
    console.log(`\n${s.provider}  occupied=${s.occupied}`);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'bigint' || /price|fee/i.test(k)) {
        console.log(`   ${k.padEnd(22)} ${String(v).padEnd(24)} ${fmt(toOG(v))} 0G`);
      }
    }
  }

  // --- projection -----------------------------------------------------------
  const chat = inf.find((s: any) => s.serviceType === 'chatbot');
  const tuner = ft[0];

  // A rendered snapshot prompt is ~330 tokens in, ~20 tokens out (one word + framing).
  const IN_TOK = 330;
  const OUT_TOK = 20;
  const BARS = 2944;

  const inPrice = toOG(chat?.inputPrice);
  const outPrice = toOG(chat?.outputPrice);
  const ftPrice = toOG(tuner?.pricePerToken);

  console.log('\n=== PROJECTION ===');
  if (!Number.isNaN(inPrice) && !Number.isNaN(outPrice)) {
    const perCall = inPrice * IN_TOK + outPrice * OUT_TOK;
    console.log(`inference per decision      ${fmt(perCall)} 0G`);
    console.log(`generation 0, all ${BARS} bars   ${fmt(perCall * BARS)} 0G`);
    console.log(`generation 0, every 4th bar  ${fmt((perCall * BARS) / 4)} 0G`);
  } else {
    console.log('inference price fields not exposed on the service struct — see raw dump above');
  }

  if (!Number.isNaN(ftPrice)) {
    for (const [label, tokens] of [
      ['100 examples  (20k tok)', 20_000],
      ['250 examples  (50k tok)', 50_000],
      ['500 examples (100k tok)', 100_000],
    ] as const) {
      const cost = tokens * 3 * ftPrice + 0.01; // 3 epochs + storage reserve
      console.log(`fine-tune ${label}   ${fmt(cost)} 0G per generation`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
