# services/storage

Trace persistence locally, and content-addressed publication to 0G Storage.

## Contract

- `serializeTraces(traces)` / `parseTraces(text)` - deterministic JSONL
- `writeTraces(path, traces)` / `readTraces(path)`
- `computeRoot(filePath)` -> Merkle root, local, no network, no funds
- `uploadFile(filePath, {privateKey})` -> `{root, txHash, alreadyPresent}`
- `downloadFile(root, dest, {withProof})`

## Why serialisation is written out key by key

The Merkle root of this output is committed on chain. Spreading the object would let a
field reorder in the type definition silently change the root and break reproducibility of
an entire lineage, with no test failing.

## Two 0G Storage facts that cost time

`merkleTree()` must be called before `upload()`. It populates state the uploader depends
on; skip it and you produce a file the network cannot address.

An "already exists" response is success. Content is addressed by hash, so re-uploading
identical bytes is a no-op, not an error.

## Test

    pnpm tsx --test services/storage/test/*.test.ts
