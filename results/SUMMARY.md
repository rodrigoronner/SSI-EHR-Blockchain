# Results Summary

Measured from a real deployment of `EHRRegistry.sol` on a local Hardhat network (chain id `31337`), with Solidity 0.8.24, Hardhat 2.29.0, ethers 6.17, and Node.js 22. Every number here is measured rather than estimated; the raw data is in `cost-evaluation.json`, `performance-evaluation.json`, and `offchain-performance.json`, and the procedures are in `scripts/benchmark-*.js`.

Re-running the benchmarks regenerates the JSON/CSV files. If you do that, the numbers below may shift slightly (gas is deterministic, wall-clock timings are not) — treat the JSON as authoritative.

## 1. Cost

Gas price 20 gwei, ETH/USD $3,000. Both are stated assumptions, not a live price feed. 5 trials per operation, each against a distinct identity so that repeated measurements of the same operation are comparable.

Unlike the timing benchmarks, these carry essentially no measurement uncertainty: the six core operations each varied by exactly 12 gas (95% CI ±6.7, under 0.02% of the mean), and the three guardian operations not at all. The 12-gas spread is not noise — one of the five identity addresses contains a zero byte, and under EIP-2028, a calldata zero byte costs 4 gas instead of 16. Gas is a deterministic function of the transaction and transfers unchanged to any EVM network.

| Operation | Gas (mean) | Gas (min–max) | Cost (ETH) | Cost (USD) |
|---|---|---|---|---|
| `addDelegate` | 72,212 | 72,202–72,214 | 0.00144424 | $4.33 |
| `revokeDelegate` | 37,679 | 37,669–37,681 | 0.00075358 | $2.26 |
| `setAttribute` (~41 B, service URL) | 34,752 | 34,742–34,754 | 0.00069504 | $2.09 |
| `setAttribute` (~59 B, IPFS CID) | 34,944 | 34,934–34,946 | 0.00069888 | $2.10 |
| `revokeAttribute` | 34,658 | 34,648–34,660 | 0.00069316 | $2.08 |
| `changeOwner` | 51,763 | 51,753–51,765 | 0.00103526 | $3.11 |
| `setGuardians` (3 guardians) | 143,520 | 143,520 | 0.00287040 | $8.61 |
| `approveRecovery` (below threshold) | 76,480 | 76,480 | 0.00152960 | $4.59 |
| `approveRecovery` (executes recovery) | 102,737 | 102,737 | 0.00205474 | $6.16 |

Contract deployment: one-time cost of 1,186,625 gas (0.02373250 ETH, $71.20).

Two things worth noting. `addDelegate` is the most expensive of the six core operations because it is the first write against a fresh identity and therefore pays the cold-slot premium on the shared `changed` counter as well as on the delegate slot itself; revoking that delegate costs roughly half once both are warm. And publishing an attribute costs the same whether the value is a short URL or a full IPFS CID, because the contract never persists attribute values — it only emits them as events.

Creating an identity costs nothing: under `did:ethr` the registry resolves an identity's controller to its own address until ownership is explicitly transferred, so no transaction is needed and there is no row for it above.

## 2. Performance

### 2.1 Confirmation latency vs. mining cadence

20 sequential transactions per mode.

| Mining mode | n | Mean (95% CI) | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Auto-mine (instant) | 20 | 39.7 ± 0.7 ms | 39 ms | 42 ms | 43 ms |
| Fixed 2 s blocks | 20 | 2004.1 ± 14.0 ms | 1,987 ms | 2,046 ms | 2,048 ms |
| Fixed 4 s blocks | 20 | 4002.4 ± 14.6 ms | 4,012 ms | 4,019 ms | 4,075 ms |

Mean latency tracks the configured block time almost exactly, and the intervals are narrow — under 0.8% of the mean in every configuration. The tails sit close behind: p95 exceeds the median by 7.7% under auto-mine (a 3 ms absolute difference), 3.0% at the 2 s interval, and 0.2% at the 4 s interval.

These figures measure inclusion in a block, not finality. On a public PoS network, an operation should be treated as reversible until finalized, roughly two epochs later.

### 2.2 Throughput under concurrent load (auto-mine)

Concurrent batches of `setAttribute`, round-robin across 20 funded accounts. Each account submits its own transactions in strict nonce order; different accounts run concurrently.

| Batch size | Repetitions | Elapsed | Throughput (95% CI) |
|---|---|---|---|
| 10 | 5 | 0.068 s | 151.8 ± 33.1 tx/s |
| 50 | 5 | 0.189 s | 264.4 ± 6.3 tx/s |
| 100 | 5 | 0.338 s | 296.1 ± 6.3 tx/s |
| 500 | 5 | 1.620 s | 308.6 ± 2.3 tx/s |

Throughput plateaus near 300 tx/s. Since gas per call is fixed regardless of batch size, the plateau is not EVM execution cost growing with load, but we did not isolate whether the residual bottleneck is the client submission path or the single node's block production, which under auto-mine mines one block per transaction. Read this as relative scalability on one node, not as a mainnet throughput figure.

### 2.3 Off-chain document path vs. document size

Each stage is timed separately, from a short textual report to an imaging-sized study. Random bytes stand in for real documents: whatever the plaintext, what reaches IPFS is ciphertext, which is incompressible.

All values are mean ± half-width of the 95% confidence interval, in ms.

| Size | n | Encrypt | Store (IPFS) | Retrieve (IPFS) | Decrypt | Round trip |
|---|---|---|---|---|---|---|
| 80 B | 30 | 0.006 ± 0.002 | 0.050 ± 0.022 | 0.083 ± 0.104 | 0.006 ± 0.003 | 0.146 ± 0.118 |
| 10 KB | 30 | 0.009 ± 0.001 | 0.025 ± 0.001 | 0.020 ± 0.003 | 0.006 ± 0.001 | 0.061 ± 0.004 |
| 100 KB | 30 | 0.032 ± 0.003 | 0.054 ± 0.001 | 0.025 ± 0.002 | 0.027 ± 0.002 | 0.137 ± 0.005 |
| 1 MB | 20 | 0.242 ± 0.023 | 0.412 ± 0.038 | 0.178 ± 0.035 | 0.262 ± 0.057 | 1.094 ± 0.111 |
| 10 MB | 10 | 2.713 ± 0.771 | 4.525 ± 0.450 | 0.856 ± 0.216 | 2.053 ± 0.357 | 10.147 ± 0.883 |
| 50 MB | 10 | 14.881 ± 3.124 | 18.169 ± 0.299 | 5.740 ± 2.154 | 15.680 ± 2.393 | 54.470 ± 5.644 |

The round trip is summed within each trial before being summarised, so its interval is not the sum of the per-stage intervals.

Up to roughly 100 KB, the round trip stays at or below 0.17 ms and is dominated by fixed per-call overhead, so size barely matters. Above 1 MB, every stage scales linearly, and the balance shifts: at 50 MB, encryption and decryption (30.6 ms) exceed the combined IPFS stages (23.9 ms). At the imaging scale, the bottleneck is the cryptographic layer, not the content-addressed store.

Sustained IPFS throughput at 50 MB was 2.69 GB/s storing and 8.51 GB/s retrieving (binary units, matching the MB/s figures in `offchain-performance.csv`). This is an in-process node with no network hop, so these are bounded by memory bandwidth, not a network link — treat them as a lower bound on latency; a distributed IPFS deployment would be governed by bandwidth and peer availability.

**Watch the measurement order at small sizes.** Whichever size runs first absorbs residual initialization. With only a light warm-up, measuring 80 B first rather than last inflated its store time by about 7-fold (0.148 ms vs 0.021 ms), which shifts the low end of the curve. The benchmark now runs five untimed warm-up iterations at 1 MB before timing anything. Sub-millisecond values here remain indicative rather than precise.

### 2.4 Verifiable Credentials

30 trials after an untimed warm-up pass.

| Operation | n | Mean (95% CI) | Min | Max |
|---|---|---|---|---|
| Sign | 30 | 0.583 ± 0.042 ms | 0.410 ms | 0.921 ms |
| Verify | 30 | 26.720 ± 0.654 ms | 21.409 ms | 31.698 ms |

Verification is slower because it also resolves the issuer's DID Document from the registry's event log to obtain the verification key; signing uses a key already held locally. Neither depends on document size.

**Verification cost grows with the identity's history. Because resolution walks the event log, it slows down as an identity accumulates changes. Measured against a registry on which the throughput benchmark had already recorded several hundred attribute changes per account, verification rose to 37.3 ms — about 40% higher than the 26.7 ms above. Always redeploy before measuring, and expect this to drift upward for long-lived, frequently-updated identities.

## 3. Security

33 automated tests, all passing (`npx hardhat test`), of which 16 are adversarial cases asserting that an unauthorized or invalid action fails. The requirement-by-requirement mapping is in `security-analysis.md`.

Access control is enforced entirely on-chain by the `onlyOwner` check, with no off-chain gatekeeper to bypass: unauthorized ownership transfers, delegations, and attribute changes all revert. Delegation is time-bound by construction, so a forgotten revocation degrades to "no access" rather than "permanent access". On the credential side, tampering, expiry, and issuer spoofing are each independently detected — verification attributes a credential to whichever key actually signed it, regardless of what the payload claims.

## 4. Key management

Two complementary mechanisms, covered by 11 tests in `test/recovery.test.js` plus `scripts/demo-guardian-recovery.js`.

**Storage.** `scripts/lib/keystore.js` encrypts a private key into a password-protected V3 keystore file — the format geth and MetaMask use — so the raw key is never written to disk in the clear.

**Recovery from genuine key loss.** `setGuardians(identity, guardians[], threshold)` registers an M-of-N guardian set in advance, while the key still works. If the key is later lost, `approveRecovery(identity, newAddress)` lets guardians jointly move the identity to a new address once M of them agree, without the lost key's signature. Recovery clears the guardian set, so the new owner must deliberately re-authorize guardians. `changeOwner` cannot do this, since it requires a signature from the key that was assumed lost.

## Limitations

- Measurements come from a **local Hardhat network**, not a public testnet or mainnet. Gas transfers directly (same EVM); latency and throughput are a local proxy.
- IPFS runs on an in-process Helia node with no pinning, which measures the storage mechanism but not long-term durability.
- **Revoking a delegate does not revoke decryption.** The registry controls who is recorded as authorized, but a party that has already fetched and decrypted a document keeps it. Key distribution is assumed to happen out of band and is outside the scope of this implementation.
- **On-chain metadata is public even when content is not.** Anchoring a CID reveals that an address published a document of a given category at a given time, and repeated observations are linkable.
- No formal verification or third-party audit of the contract.
- Guardian recovery has no time-lock or veto window: it executes the moment the threshold is met, so a colluding majority of guardians can take over an identity.
