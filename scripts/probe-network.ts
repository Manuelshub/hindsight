/**
 * Probes 0G Compute for live inference + fine-tuning services.
 *
 * Hindsight's whole thesis depends on fine-tuning actually being available, so this
 * runs read-only (no wallet, no funds) and tells us what is really on the network
 * rather than what the docs claim.
 *
 *   pnpm tsx scripts/probe-network.ts [testnet|mainnet]
 */
import * as sdk from '@0gfoundation/0g-compute-ts-sdk';

const NETWORKS = {
  testnet: 'https://evmrpc-testnet.0g.ai',
  mainnet: 'https://evmrpc.0g.ai',
} as const;

type NetworkName = keyof typeof NETWORKS;

function isNetworkName(v: string): v is NetworkName {
  return v in NETWORKS;
}

const arg = process.argv[2] ?? 'testnet';
const network: NetworkName = isNetworkName(arg) ? arg : 'testnet';
const rpc = NETWORKS[network];

/** The SDK's read-only factory has moved between versions; find whatever is exported. */
function resolveReadOnlyFactory(): ((rpc: string) => Promise<unknown>) | undefined {
  const mod = sdk as unknown as Record<string, unknown>;
  const candidates = Object.keys(mod).filter(
    (k) => /readonly/i.test(k) && /create/i.test(k) && typeof mod[k] === 'function',
  );
  const name = candidates.find((k) => /network|compute/i.test(k)) ?? candidates[0];
  return name ? (mod[name] as (rpc: string) => Promise<unknown>) : undefined;
}

async function main() {
  console.log(`\n=== 0G Compute probe: ${network} (${rpc}) ===\n`);

  console.log('exports containing "readonly":');
  for (const k of Object.keys(sdk as unknown as Record<string, unknown>)) {
    if (/readonly/i.test(k)) console.log(`  - ${k}`);
  }

  const factory = resolveReadOnlyFactory();
  if (!factory) {
    console.log('\nNo read-only factory exported; falling back to a random wallet.');
  }

  const broker = factory
    ? ((await factory(rpc)) as Record<string, any>)
    : await (async () => {
        const { ethers } = await import('ethers');
        const provider = new ethers.JsonRpcProvider(rpc);
        const wallet = ethers.Wallet.createRandom().connect(provider);
        return (await sdk.createZGComputeNetworkBroker(wallet as any)) as unknown as Record<
          string,
          any
        >;
      })();

  console.log('\nbroker sub-brokers:', Object.keys(broker).join(', '));

  // --- inference ---
  try {
    const services = await broker.inference.listService();
    console.log(`\n--- INFERENCE: ${services.length} service(s) ---`);
    for (const s of services) {
      console.log(
        `  model=${s.model ?? '?'}  type=${s.serviceType ?? '?'}\n` +
          `    provider=${s.provider}\n` +
          `    url=${s.url ?? '?'}  verifiability=${s.verifiability || 'none'}`,
      );
    }
  } catch (err) {
    console.log('\n--- INFERENCE: failed ---');
    console.log(' ', (err as Error).message);
  }

  // --- fine-tuning: the one that matters ---
  if (!broker.fineTuning) {
    console.log('\n--- FINE-TUNING: sub-broker not present on this broker ---');
    return;
  }
  try {
    const services = await broker.fineTuning.listService();
    console.log(`\n--- FINE-TUNING: ${services.length} service(s) ---`);
    if (services.length === 0) {
      console.log('  (none registered — blocks the generational training loop)');
    }
    for (const s of services) {
      console.log(
        `  provider=${s.provider}\n` +
          `    url=${s.url ?? '?'}  occupied=${s.occupied ?? '?'}\n` +
          `    pricePerToken=${s.pricePerToken ?? '?'}  models=${JSON.stringify(s.models ?? [])}`,
      );
    }
  } catch (err) {
    console.log('\n--- FINE-TUNING: failed ---');
    console.log(' ', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
