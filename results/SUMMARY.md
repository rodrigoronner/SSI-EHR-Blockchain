# Results Summary

Measured from a real deployment of `EHRRegistry.sol` on a local Hardhat network (chain id `31337`), with Solidity 0.8.24, Hardhat 2.29.0, ethers 6.17, and Node.js 22. Every number here is measured rather than estimated; the raw data is in `cost-evaluation.json`, `performance-evaluation.json`, and `offchain-performance.json`, and the procedures are in `scripts/benchmark-*.js`.

Re-running the benchmarks regenerates the JSON/CSV files. If you do that, the numbers below may shift slightly (gas is deterministic, wall-clock timings are not) — treat the JSON as authoritative.

## 1. Cost

Gas price 20 gwei, ETH/USD $3,000. Both are stated assumptions, not a live price feed. 5 trials per operation, each against a distinct identity so that repeated measurements of the same operation are comparable.

| Operation | Gas (mean) | Gas (min–max) | Cost (ETH) | Cost (USD) |
|---|---|---|---|---|
| `addDelegate` | 72,212 | 72,202–72,214 | 0.00144424 | $4.33 |
| `revokeDelegate` | 37,679 | 37,669–37,681 | 0.00075358 | $2.26 |
| `setAttribute` (~41 B, service URL) | 34,752 | 34,742–34,754 | 0.00069504 | $2.09 |
| `setAttribute` (~59 B, IPFS CID) | 34,944 | 34,934–34,946 | 0.00069888 | $2.10 |
| `revokeAttribute` | 34,658 | 34,648–34,660 | 0.00069316 | $2.08 |
| `changeOwner` | 51,760 | 51,741–51,765 | 0.00103520 | $3.11 |
| `setGuardians` (3 guardians) | 143,520 | 143,520 | 0.00287040 | $8.61 |
| `approveRecovery` (below threshold) | 76,480 | 76,480 | 0.00152960 | $4.59 |
| `approveRecovery` (executes recovery) | 102,737 | 102,737 | 0.00205474 | $6.16 |

Contract deployment, a one-time cost: 1,186,625 gas (0.02373250 ETH, $71.20).

Two things worth noting. `addDelegate` is the most expensive of the six core operations because it is the first write against a fresh identity and therefore pays the cold-slot premium on the shared `changed` counter as well as on the delegate slot itself; revoking that delegate costs roughly half once both are warm. And publishing an attribute costs the same whether the value is a short URL or a full IPFS CID, because the contract never persists attribute values — it only emits them as events.

Creating an identity costs nothing: under `did:ethr` the registry resolves an identity's controller to its own address until ownership is explicitly transferred, so no transaction is needed and there is no row for it above.

## 2. Performance

### 2.1 Confirmation latency vs. mining cadence

8 sequential transactions per mode.

| Mining mode | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|
| Auto-mine (instant) | 38 ms | 43 ms | 43 ms | 38 ms | 43 ms |
| Fixed 2 s blocks | 2,026 ms | 2,039 ms | 2,039 ms | 1,964 ms | 2,039 ms |
| Fixed 4 s blocks | 3,991 ms | 4,061 ms | 4,061 ms | 3,983 ms | 4,061 ms |

Median latency tracks the configured block time almost exactly. Under the fixed intervals p95 sits under 2% above the median; under auto-mine the relative spread is larger (13%) but the absolute difference is 5 ms and reflects client-side RPC scheduling rather than the chain.

These figures measure inclusion in a block, not finality. On a public PoS network an operation should be treated as reversible until finalised, roughly two epochs later.

### 2.2 Throughput under concurrent load (auto-mine)

Concurrent batches of `setAttribute`, round-robined across 20 funded accounts. Each account submits its own transactions in strict nonce order; different accounts run concurrently.

| Batch size | Elapsed | Throughput |
|---|---|---|
| 10 | 0.084 s | 119.0 tx/s |
| 50 | 0.205 s | 243.9 tx/s |
| 100 | 0.349 s | 286.5 tx/s |
| 500 | 1.674 s | 298.7 tx/s |

Throughput plateaus near 300 tx/s. Since gas per call is fixed regardless of batch size, the plateau is not EVM execution cost growing with load — but we did not isolate whether the residual bottleneck is the client submission path or the single node's block production, which under auto-mine mines one block per transaction. Read this as relative scalability on one node, not as a mainnet throughput figure.

### 2.3 Off-chain document path vs. document size

Each stage timed separately, from a short textual report to an imaging-sized study. Random bytes stand in for real documents: whatever the plaintext, what reaches IPFS is ciphertext, which is incompressible.

| Size | Trials | Encrypt | Store (IPFS) | Retrieve (IPFS) | Decrypt | Round trip |
|---|---|---|---|---|---|---|
| 80 B | 10 | 0.009 ms | 0.098 ms | 0.206 ms | 0.014 ms | 0.33 ms |
| 10 KB | 10 | 0.008 ms | 0.029 ms | 0.033 ms | 0.006 ms | 0.08 ms |
| 100 KB | 10 | 0.029 ms | 0.054 ms | 0.025 ms | 0.027 ms | 0.14 ms |
| 1 MB | 10 | 0.227 ms | 0.416 ms | 0.228 ms | 0.268 ms | 1.14 ms |
| 10 MB | 5 | 3.222 ms | 4.350 ms | 0.980 ms | 2.083 ms | 10.63 ms |
| 50 MB | 3 | 21.607 ms | 18.957 ms | 8.533 ms | 15.046 ms | 64.14 ms |

Up to roughly 100 KB the round trip stays under 0.35 ms and is dominated by fixed per-call overhead, so size barely matters. Above 1 MB every stage scales linearly, and the balance shifts: at 50 MB, encryption plus decryption (36.7 ms) exceed both IPFS stages combined (27.5 ms). At imaging scale the bottleneck is the cryptographic layer, not the content-addressed store.

Sustained IPFS throughput at 50 MB was 2.58 GB/s storing and 5.72 GB/s retrieving (binary units, matching the MB/s figures in `offchain-performance.csv`). This is an in-process node with no network hop, so these are bounded by memory bandwidth, not a network link — treat them as a lower bound on latency; a distributed IPFS deployment would be governed by bandwidth and peer availability.

**Watch the measurement order at small sizes.** Whichever size runs first absorbs residual initialisation. With only a light warm-up, measuring 80 B first rather than last inflated its store time about sevenfold (0.148 ms vs 0.021 ms), which inverts the low end of the curve. The benchmark now runs five untimed warm-up iterations at 1 MB before timing anything. Sub-millisecond values here remain indicative rather than precise.

### 2.4 Verifiable Credentials

10 trials after an untimed warm-up pass.

| Operation | Mean | Min | Max |
|---|---|---|---|
| Sign | 0.50 ms | 0.41 ms | 0.70 ms |
| Verify | 25.50 ms | 21.63 ms | 27.45 ms |

Verification is the slower side because it additionally resolves the issuer's DID Document from the registry's event log to obtain the verification key; signing uses a key already held locally. Neither depends on document size.

## 3. Security

33 automated tests, all passing (`npx hardhat test`), of which 16 are adversarial cases asserting that an unauthorised or invalid action fails. The requirement-by-requirement mapping is in `security-analysis.md`.

Access control is enforced entirely on-chain by the `onlyOwner` check, with no off-chain gatekeeper to bypass: unauthorised ownership transfers, delegations, and attribute changes all revert. Delegation is time-bounded by construction, so a forgotten revocation degrades to "no access" rather than "permanent access". On the credential side, tampering, expiry, and issuer spoofing are each independently detected — verification attributes a credential to whichever key actually signed it, regardless of what the payload claims.

## 4. Key management

Two complementary mechanisms, covered by 11 tests in `test/recovery.test.js` plus `scripts/demo-guardian-recovery.js`.

**Storage.** `scripts/lib/keystore.js` encrypts a private key into a password-protected V3 keystore file — the format geth and MetaMask use — so the raw key is never written to disk in the clear.

**Recovery from genuine key loss.** `setGuardians(identity, guardians[], threshold)` registers an M-of-N guardian set in advance, while the key still works. If the key is later lost, `approveRecovery(identity, newAddress)` lets guardians jointly move the identity to a new address once M of them agree, with no signature from the lost key. Recovery clears the guardian set, so the new owner must deliberately re-authorise guardians. `changeOwner` cannot do this, since it requires a signature from precisely the key assumed lost.

## Limitations

- Measurements come from a **local Hardhat network**, not a public testnet or mainnet. Gas transfers directly (same EVM); latency and throughput are a local proxy.
- IPFS runs on an in-process Helia node with no pinning, which measures the storage mechanism but not long-term durability.
- **Revoking a delegate does not revoke decryption.** The registry controls who is recorded as authorised, but a party who already fetched and decrypted a document keeps it. Key distribution is assumed to happen out of band and is outside the scope of this implementation.
- **On-chain metadata is public even when content is not.** Anchoring a CID reveals that an address published a document of a given category at a given time, and repeated observations are linkable.
- No formal verification or third-party audit of the contract.
- Guardian recovery has no time-lock or veto window: it executes the moment the threshold is met, so a colluding majority of guardians can take over an identity.
