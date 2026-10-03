# Results Summary

Measured from a real deployment of `EHRRegistry.sol` on a local Hardhat network (chain id `31337`), with Solidity 0.8.24, Hardhat 2.29.0, ethers 6.17, and Node.js 22, under Hardhat's default Osaka hard fork. All timings were measured on a laptop with an Apple M5 processor (ARM64, 10 cores) and 16 GB of RAM, under macOS; absolute values will differ on other machines. Every number here is measured rather than estimated; the raw data is in `cost-evaluation.json`, `performance-evaluation.json`, `offchain-performance.json`, and `vc-history.json`, and the procedures are in `scripts/benchmark-*.js`. The figures in `figures/` are generated from these files by `scripts/make_figures.py` (`npm run figures`).

Re-running the benchmarks regenerates the JSON/CSV files. If you do that, the numbers below may shift slightly (gas is deterministic, wall-clock timings are not) — treat the JSON as authoritative.

## 1. Cost

Gas price 20 gwei, ETH/USD $3,000. Both are stated assumptions, not a live price feed. 5 trials per operation, each against a distinct identity so that repeated measurements of the same operation are comparable.

Unlike the timing benchmarks, these carry essentially no measurement uncertainty: the six core operations each varied by 12 gas across the five identities (95% CI at most ±8.2, under 0.02% of the mean), and the three guardian operations not at all. The 12-gas spread is not noise — one of the five identity addresses contains a zero byte, and under EIP-2028, a calldata zero byte costs 4 gas instead of 16. `changeOwner` also passes a target address, and one of its five targets contains a zero byte too, so two of its trials are 12 gas cheaper instead of one; that is why its interval is ±8.2 rather than ±6.7. Every input is fixed (including `changeOwner`'s target address), so two runs on fresh deployments produce identical results. Gas is a deterministic function of the transaction and transfers unchanged to any EVM network running the same hard fork; upgrades that reprice opcodes (e.g. EIP-2929, EIP-3529) change it.

| Operation | Gas (mean) | Gas (min–max) | Cost (ETH) | Cost (USD) |
|---|---|---|---|---|
| `addDelegate` | 72,212 | 72,202–72,214 | 0.00144424 | $4.33 |
| `revokeDelegate` | 37,679 | 37,669–37,681 | 0.00075358 | $2.26 |
| `setAttribute` (~41 B, service URL) | 34,752 | 34,742–34,754 | 0.00069504 | $2.09 |
| `setAttribute` (~59 B, IPFS CID) | 34,836 | 34,826–34,838 | 0.00069672 | $2.09 |
| `revokeAttribute` | 34,550 | 34,540–34,552 | 0.00069100 | $2.07 |
| `changeOwner` | 53,983 | 53,976–53,988 | 0.00107966 | $3.24 |
| `setGuardians` (3 guardians) | 165,828 | 165,828 | 0.00331656 | $9.95 |
| `approveRecovery` (below threshold) | 78,856 | 78,856 | 0.00157712 | $4.73 |
| `approveRecovery` (executes recovery) | 108,319 | 108,319 | 0.00216638 | $6.50 |

Contract deployment: one-time cost of 1,306,373 gas (0.02612746 ETH, $78.38).

Cost scales linearly with gas price, so the same nine operations can be read at any price without a new measurement (ETH/USD fixed at $3,000):

| Gas price | Cheapest operation (`revokeAttribute`) | Most expensive (`setGuardians`) |
|---|---|---|
| 1 gwei | $0.10 | $0.50 |
| 5 gwei | $0.52 | $2.49 |
| 10 gwei | $1.04 | $4.97 |
| 20 gwei (used above) | $2.07 | $9.95 |
| 50 gwei | $5.18 | $24.87 |
| 100 gwei | $10.37 | $49.75 |

Each figure is `meanGas × gasPrice × 10⁻⁹ × 3000`, from the means in `cost-evaluation.json`.

Where the gas goes. Every transaction pays a 21,000-gas base cost, which is about 60% of a `setAttribute`. The large differences come from storage writes: writing a non-zero value into a slot that holds zero costs 20,000 gas, against 2,900 to overwrite a non-zero value. `addDelegate` is the most expensive core operation because, as the first write against a fresh identity, it fills two empty slots (the delegate's expiry and the `changed` counter); revoking that delegate overwrites both and costs about half. This is not a cold/warm effect: EIP-2929's warm slots last only within one transaction, and adding the same delegate again in a later transaction costs 38,014 gas, about the same as revoking it on that identity (37,681, the per-trial cost of `revokeDelegate` whenever the identity address has no zero byte; the table's 37,679 is the average including the one trial that has). Likewise, the first `setAttribute` on a fresh identity costs exactly 17,100 more than later ones (51,818 against 34,718), which is the cost of filling one empty slot. These figures are in the `mechanics` section of `cost-evaluation.json`, measured on a separate identity with fixed inputs.

Attribute values are never stored, only passed in calldata and emitted in the event, so they add about 30 gas per byte rather than 20,000 per 32-byte word. The short URL and the CID cost almost the same because both fit in the same two 32-byte ABI words; the cost is not flat in general (34,138 gas for a 32-byte value, 41,855 for 320 bytes, 64,830 for 1 KB). A CID, however, has a fixed length whatever the size of the document it points to.

The guardian operations also maintain a per-identity recovery epoch (see Key management below), which adds a storage write to `setGuardians` and lets `changeOwner` clear a previous owner's guardians.

Creating an identity costs nothing: under `did:ethr` the registry resolves an identity's controller to its own address until ownership is explicitly transferred, so no transaction is needed and there is no row for it above.

## 2. Performance

### 2.1 Inclusion latency vs. mining cadence

100 transactions per mode, each submitted after a random delay drawn uniformly from one block interval (seeded, so the delays are the same on every run). Without that delay, each transaction would be sent right after the previous one was mined and would always wait a full interval, which measures the worst case rather than a typical wait.

| Mining mode | n | Mean (95% CI) | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Auto-mine (instant) | 100 | 43.5 ± 0.5 ms | 44 ms | 47 ms | 48 ms |
| Fixed 2 s blocks | 100 | 983.8 ± 114.0 ms | 966 ms | 1,933 ms | 2,059 ms |
| Fixed 4 s blocks | 100 | 2,047.4 ± 213.4 ms | 1,903 ms | 3,809 ms | 4,060 ms |

With submissions independent of the block schedule, the mean wait is half the block interval (1,000 ms and 2,000 ms), which both confidence intervals contain, and the tail approaches the full interval. The wide intervals reflect that uniform spread, not measurement noise. An earlier run with 20 samples per mode gave 1,284 ± 207 ms at the 2 s interval, whose interval did not contain 1,000 ms; with a uniform wait the standard error of a 20-sample mean is about 130 ms, so that run was sampling variation, which 100 samples reduce enough to resolve.

These figures measure inclusion in a block on a single local node, not finality. On a public PoS network, an operation should be treated as reversible until finalized, two epochs (about 12.8 minutes) later.

### 2.2 Throughput under concurrent load (auto-mine)

Concurrent batches of `setAttribute`, round-robin across 20 funded accounts. Each account submits its own transactions in strict nonce order; different accounts run concurrently.

| Batch size | Repetitions | Elapsed | Throughput (95% CI) |
|---|---|---|---|
| 10 | 5 | 0.069 s | 150.4 ± 36.2 tx/s |
| 50 | 5 | 0.187 s | 268.1 ± 8.8 tx/s |
| 100 | 5 | 0.327 s | 306.0 ± 2.9 tx/s |
| 500 | 5 | 1.575 s | 317.5 ± 3.9 tx/s |

Throughput plateaus near 300 tx/s on this single in-process node. Since gas per call is fixed regardless of batch size, the plateau is not EVM execution cost growing with load, but we did not isolate whether the residual bottleneck is the client submission path or the single node's block production, which under auto-mine mines one block per transaction. Read this as relative scalability on one node, not as a mainnet throughput figure.

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

Sustained IPFS throughput at 50 MB was 2.69 GB/s storing and 8.51 GB/s retrieving (binary units, matching the MB/s figures in `offchain-performance.csv`). This is an in-process Helia node with an in-memory blockstore: no peer discovery, DHT lookup, or network transfer is included, so these figures are bounded by memory bandwidth and measure the client-side cost only. A distributed IPFS deployment would be governed by bandwidth and peer availability and can take seconds for an imaging-sized object, so they say nothing about whether IPFS or the blockchain dominates end-to-end latency in practice.

**Watch the measurement order at small sizes.** Whichever size runs first absorbs residual initialization. With only a light warm-up, measuring 80 B first rather than last inflated its store time by about 7-fold (0.148 ms vs 0.021 ms), which shifts the low end of the curve. The benchmark now runs five untimed warm-up iterations at 1 MB before timing anything. Sub-millisecond values here remain indicative rather than precise.

### 2.4 Verifiable Credentials

30 trials after an untimed warm-up pass.

| Operation | n | Mean (95% CI) | Min | Max |
|---|---|---|---|---|
| Sign | 30 | 0.583 ± 0.042 ms | 0.410 ms | 0.921 ms |
| Verify | 30 | 26.720 ± 0.654 ms | 21.409 ms | 31.698 ms |

Verification is slower because it also resolves the issuer's DID Document from the registry's event log to obtain the verification key; signing uses a key already held locally. Neither depends on document size.

### 2.5 Verification cost vs. the issuer's history

Because resolution walks the issuer's event log, verification slows down as the issuer accumulates changes. `scripts/benchmark-vc-history.js` (`npm run bench:vc-history`) grows the issuing physician's history in steps, with each change a distinct attribute, and times 30 verifications at each step after three untimed warm-up passes.

| Prior changes | n | Median (p50) | p95 | Mean (95% CI) | Median vs. baseline |
|---|---|---|---|---|---|
| 0 | 30 | 28.1 ms | 30.5 ms | 29.9 ± 4.5 ms | 1.00× |
| 100 | 30 | 29.3 ms | 32.0 ms | 29.7 ± 0.6 ms | 1.04× |
| 250 | 30 | 38.7 ms | 272.2 ms | 110.9 ± 131.9 ms | 1.38× |
| 500 | 30 | 49.2 ms | 49.6 ms | 49.0 ± 0.2 ms | 1.75× |

The median is the figure to read here. In two runs, a single resolution at the 250-change level stalled for about 2 s on the local node, which inflates that row's mean and interval without reflecting the cost of resolution itself; the medians of the two runs agreed within 3 ms at every level. Always redeploy before measuring, and expect verification to drift upward for long-lived, frequently updated identities. The resolver fetches each step of the history with a separate log query, so against a remote RPC provider every step is a network round trip and the growth would be steeper than measured here.

## 3. Security

48 automated tests, all passing (`npm test`), of which 24 are adversarial cases asserting that an unauthorized or invalid action fails. Adversarial tests carry an `[adversarial]` tag in their names, so `npm run test:adversarial` runs exactly those 24. Instrumented with `solidity-coverage` (`npm run coverage`), the suite exercises 100% of the contract's statements, branches, functions, and lines. The requirement-by-requirement mapping is in `security-analysis.md`.

What the registry controls is who may change an identity's state: unauthorized ownership transfers, delegations, attribute changes, and guardian changes all revert, with no off-chain gatekeeper to bypass. It does not control who may read a document; that depends on who holds the document's AES key, which is distributed out of band. Delegates have no power on-chain either: they appear in the DID Document's `authentication` list, so a relying party can accept a JWT they sign on the identity's behalf, but they cannot call any registry function. Every delegation carries an expiry, so a forgotten revocation degrades to "no access" rather than "permanent access", although the contract does not cap how long that expiry may be. On the credential side, tampering, expiry, and issuer spoofing are each independently detected — verification attributes a credential to whichever key actually signed it, regardless of what the payload claims.

## 4. Key management

Two complementary mechanisms, covered by 17 tests in `test/recovery.test.js` plus `scripts/demo-guardian-recovery.js`.

**Storage.** `scripts/lib/keystore.js` encrypts a private key into a password-protected V3 keystore file — the format geth and MetaMask use — so the raw key is never written to disk in the clear.

**Recovery from genuine key loss.** `setGuardians(identity, guardians[], threshold)` registers an M-of-N guardian set in advance, while the key still works. If the key is later lost, `approveRecovery(identity, newAddress)` lets guardians jointly move the identity to a new address once M of them agree, without the lost key's signature. Recovery clears the guardian set, so the new owner must deliberately re-authorize guardians. `changeOwner` cannot do this, since it requires a signature from the key that was assumed lost.

Approvals are counted per recovery epoch, which moves on whenever the guardian set changes, a recovery completes, ownership is transferred, or the owner calls `cancelRecovery`. An earlier version counted approvals per proposed address only, so an approval from a guardian who had since been removed, or one left over from before a recovery, still counted towards a later threshold; with threshold 2, a single new approval could then complete a recovery. Six regression tests cover those cases. Transferring ownership also clears the guardian set, so a new owner, such as a hospital's acquirer, does not inherit the previous owner's guardians, and `changeOwner` now rejects the zero address, which would have handed control back to the identity's original key.

What a change of owner does not change: delegates and attributes published before a transfer or a recovery stay valid until they expire or the new owner revokes them, so after a hospital is acquired, the previous owner's delegates could still authenticate as the hospital. The new owner should revoke them one by one (`test/EHRRegistry.test.js` exercises this). The contract cannot drop them itself, because resolvers rebuild the DID Document from delegation events, not from contract storage.

What recovery does not restore: the AES keys of the patient's documents are not bound to the DID, so if they lived on the lost device they are not recovered with it. And once an identity's owner changes, Verifiable Credentials signed by the previous key no longer verify against the current DID Document; a verifier would have to resolve the issuer's DID as of the credential's issuance time.

## Limitations

- Measurements come from a **local Hardhat network**, not a public testnet or mainnet. Gas transfers directly (same EVM); latency and throughput are a local proxy.
- IPFS runs on an in-process Helia node with no pinning, which measures the storage mechanism but not long-term durability.
- **Revoking a delegate does not revoke decryption.** The registry controls who is recorded as authorized, but a party that has already fetched and decrypted a document keeps it. Key distribution is assumed to happen out of band and is outside the scope of this implementation.
- **On-chain metadata is public even when content is not.** Anchoring a CID reveals that an address published a document of a given category at a given time, and repeated observations are linkable.
- No formal verification or third-party audit of the contract.
- Guardian recovery has no time-lock: it executes the moment the threshold is met, so a colluding majority of guardians can take over an identity. `cancelRecovery` lets an owner who still holds the key discard approvals before the threshold is reached, but not undo a completed recovery. It also offers nothing against key theft, since a thief holding the key can change the guardians or the owner first.
- The `*Signed` meta-transaction functions of ERC-1056 are not implemented, so only the identity's owner can write to it, paying the gas. A physician cannot anchor a document on a patient's DID without the patient's transaction, and the patient can later revoke that anchor.
