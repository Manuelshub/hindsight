/**
 * Prints the operator wallet address and its balance on both 0G networks.
 * Never prints the private key.
 *
 *   node_modules/.bin/tsx scripts/wallet-status.ts
 */
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const NETWORKS: Array<[string, string]> = [
  ['testnet', 'https://evmrpc-testnet.0g.ai'],
  ['mainnet', 'https://evmrpc.0g.ai'],
];

async function main() {
  const env = loadEnv('.env');
  const raw = env.PRIVATE_KEY;

  if (!raw) {
    console.log('PRIVATE_KEY is not set in .env');
    return;
  }

  const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(pk);
  } catch (err) {
    console.log(`PRIVATE_KEY is present but not a valid key: ${(err as Error).message}`);
    console.log('(expected 32 bytes hex, with or without the 0x prefix)');
    return;
  }

  console.log(`address: ${wallet.address}\n`);

  for (const [name, rpc] of NETWORKS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const balance = await Promise.race([
        provider.getBalance(wallet.address),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('rpc timeout')), 25_000),
        ),
      ]);
      console.log(`  ${name.padEnd(8)} ${ethers.formatEther(balance)} 0G`);
    } catch (err) {
      console.log(`  ${name.padEnd(8)} unreachable — ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
