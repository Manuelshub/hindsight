/**
 * 0G Storage client.
 *
 * Everything the chain commits to is a Merkle root produced here: trace sets, training
 * datasets, and adapters. Computing a root is separated from uploading so tests and
 * dry runs can verify content addressing without spending anything.
 */
import { ethers } from 'ethers';
import { Indexer, ZgFile } from '@0gfoundation/0g-storage-ts-sdk';

import { TESTNET, type NetworkConfig } from '../../../config/index.js';

export interface StorageOptions {
  network?: NetworkConfig;
  privateKey?: string;
}

function resolve(options: StorageOptions) {
  const network = options.network ?? TESTNET;
  return { network, indexer: new Indexer(network.indexerUrl) };
}

/**
 * Merkle root of a file, computed locally. No network, no funds — this is what a
 * `--dry-run` uses to show exactly what would be committed.
 */
export async function computeRoot(filePath: string): Promise<string> {
  const file = await ZgFile.fromFilePath(filePath);
  try {
    const [tree, err] = await file.merkleTree();
    if (err) throw err;
    const root = tree?.rootHash();
    if (!root) throw new Error(`could not compute Merkle root for ${filePath}`);
    return root;
  } finally {
    await file.close?.();
  }
}

export interface UploadResult {
  root: string;
  txHash?: string;
  alreadyPresent: boolean;
}

/**
 * Uploads a file and returns its root.
 *
 * `merkleTree()` must be called before `upload()` — it populates internal state the
 * uploader depends on, and skipping it produces a file the network cannot address.
 * An "already exists" response is success, not failure: the content is addressed by
 * hash, so a re-upload of identical bytes is a no-op.
 */
export async function uploadFile(
  filePath: string,
  options: StorageOptions = {},
): Promise<UploadResult> {
  const { network, indexer } = resolve(options);
  const privateKey = options.privateKey;
  if (!privateKey) throw new Error('uploadFile requires a private key');

  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const file = await ZgFile.fromFilePath(filePath);
  try {
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) throw treeErr;
    const root = tree?.rootHash();
    if (!root) throw new Error(`could not compute Merkle root for ${filePath}`);

    const [tx, uploadErr] = await indexer.upload(file, network.rpcUrl, signer);
    if (uploadErr) {
      const message = String((uploadErr as Error).message ?? uploadErr);
      if (/already exists|Duplicate/i.test(message)) {
        return { root, alreadyPresent: true };
      }
      throw uploadErr;
    }

    return { root, txHash: typeof tx === 'string' ? tx : undefined, alreadyPresent: false };
  } finally {
    await file.close?.();
  }
}

/** Retrieves a file by root. `withProof` verifies each segment against the Merkle tree. */
export async function downloadFile(
  root: string,
  destPath: string,
  options: StorageOptions & { withProof?: boolean } = {},
): Promise<void> {
  const { indexer } = resolve(options);
  const err = await indexer.download(root, destPath, options.withProof ?? true);
  if (err) throw err;
}
