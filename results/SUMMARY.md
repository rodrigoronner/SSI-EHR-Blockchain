# Results Summary

Generated from a real deployment of `EHRRegistry.sol` on a local Hardhat network (chain id `31337`, Node v22, Hardhat 2.29, ethers 6.17). All numbers below are measured, not estimated — see `scripts/benchmark-cost.js` and `scripts/benchmark-performance.js` for the exact procedure, and `cost-evaluation.json`/`performance-evaluation.json` for raw data.

## 1. Cost Evaluation

Assumptions (explicit, not a live price feed): gas price = 20 gwei, ETH/USD = $3,000. 5 trials per operation, each on a freshly-created identity to avoid warm-storage discounts masking the real first-use cost (revoke/changeOwner are measured following a prior add/first-touch on that same identity, matching how they'd actually be used).

| Operation | Gas (mean) | Gas (min–max) | Cost (ETH) | Cost (USD, @ $3,000/ETH) |
|---|---|---|---|---|
| `addDelegate` | 72,234 | 72,224–72,236 | 0.00144468 | $4.33 |
| `revokeDelegate` | 37,634 | 37,624–37,636 | 0.00075268 | $2.26 |
| `setAttribute` (~41 B value, service URL) | 34,818 | 34,808–34,820 | 0.00069636 | $2.09 |
| `setAttribute` (~59 B value, IPFS CID) | 35,010 | 35,000–35,012 | 0.00070020 | $2.10 |
| `revokeAttribute` | 34,635 | 34,625–34,637 | 0.00069270 | $2.08 |
| `changeOwner` | 51,741 | 51,731–51,743 | 0.00103482 | $3.10 |

LaTeX-ready:
```latex
\begin{table}[h]
\centering
\caption{Gas cost per EHRRegistry operation (mean of 5 trials, 20 gwei, ETH = \$3{,}000)}
\begin{tabular}{|l|r|r|r|}
\hline
\textbf{Operation} & \textbf{Gas (mean)} & \textbf{Cost (ETH)} & \textbf{Cost (USD)} \\
\hline
addDelegate & 72{,}234 & 0.00144468 & \$4.33 \\
revokeDelegate & 37{,}634 & 0.00075268 & \$2.26 \\
setAttribute (URL, \textasciitilde41B) & 34{,}818 & 0.00069636 & \$2.09 \\
setAttribute (IPFS CID, \textasciitilde59B) & 35{,}010 & 0.00070020 & \$2.10 \\
revokeAttribute & 34{,}635 & 0.00069270 & \$2.08 \\
changeOwner & 51{,}741 & 0.00103482 & \$3.10 \\
\hline
\end{tabular}
\end{table}
```

**In-line text for Section 6.1 (Cost Evaluation):**
> Under a representative gas price of 20 gwei and an ETH/USD rate of \$3{,}000, the six on-chain operations exposed by the EHRRegistry contract cost between 34{,}635 and 72{,}234 gas (\$2.08–\$4.33 per call). Delegation (`addDelegate`) is the most expensive operation, since it is the only one writing to a previously-untouched (cold) storage slot; its own revocation is roughly half the cost once that slot is warm. Publishing or revoking an attribute — the mechanism used for both service-endpoint discovery and anchoring off-chain IPFS document hashes — costs under \$2.10 regardless of whether the value is a short URL or a full IPFS CID, since the dominant cost is event-log emission rather than storage.

## 2. Performance Evaluation

### 2.1 Latency vs. mining cadence

8 sequential transactions per mode.

| Mining mode | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|
| Auto-mine (instant, e.g. L2/permissioned-style) | 38 ms | 43 ms | 43 ms | 38 ms | 43 ms |
| Fixed interval, 2 s blocks (approximates a fast public chain) | 2026 ms | 2039 ms | 2039 ms | 1964 ms | 2039 ms |
| Fixed interval, 4 s blocks | 3991 ms | 4061 ms | 4061 ms | 3983 ms | 4061 ms |

**In-line text:**
> Confirmation latency is dominated entirely by the network's block time, not by contract execution: under instant (auto-mined) local settings — representative of an L2 or permissioned deployment — median confirmation was 38 ms. Under fixed 2 s and 4 s block intervals, approximating public-chain conditions, median confirmation tracked the configured interval almost exactly (2,026 ms and 3,991 ms respectively), with p95/p99 adding only 1–2% overhead. This confirms that EHRRegistry's own gas cost (Section 6.1) is not the bottleneck for any deployment target; end-to-end latency is set by the choice of underlying network.

### 2.2 Throughput / scalability (auto-mine)

Concurrent batches of `setAttribute` calls, round-robined across 20 funded accounts (each account's own transactions submitted in strict nonce order; different accounts run concurrently).

| Batch size | Elapsed | Throughput |
|---|---|---|
| 10 | 0.084 s | 119.0 tx/s |
| 50 | 0.205 s | 243.9 tx/s |
| 100 | 0.349 s | 286.5 tx/s |
| 500 | 1.674 s | 298.7 tx/s |

LaTeX-ready:
```latex
\begin{table}[h]
\centering
\caption{Throughput under concurrent load (auto-mine, local network)}
\begin{tabular}{|r|r|r|}
\hline
\textbf{Batch size} & \textbf{Elapsed (s)} & \textbf{Throughput (tx/s)} \\
\hline
10  & 0.084 & 119.0 \\
50  & 0.205 & 243.9 \\
100 & 0.349 & 286.5 \\
500 & 1.674 & 298.7 \\
\hline
\end{tabular}
\end{table}
```

**In-line text:**
> Throughput scales with concurrent load and plateaus around 300 tx/s on this local single-node setup, growing from 119 tx/s at a batch of 10 to 299 tx/s at a batch of 500 — indicating the client-side submission pipeline (not the EVM itself) is the limiting factor at this scale, since gas cost per call is fixed regardless of batch size. This is a proxy for relative scalability, not a mainnet throughput claim (see limitations below).

## 3. Security Analysis

33/33 automated tests passing (`npx hardhat test`). Full requirement-by-requirement mapping in `security-analysis.md`. Headline result for the paper's Section 6.3:

> All access-control requirements (Section 3) are enforced on-chain by EHRRegistry's `onlyOwner` modifier: every attempted unauthorized ownership transfer, delegation, or attribute change was rejected in testing. Delegated authorization is time-bounded by construction and was confirmed to lapse automatically once its validity period elapses, independent of explicit revocation; explicit revocation was confirmed to take effect immediately rather than waiting for natural expiry. On the Verifiable Credential side, tampering with a signed credential's payload and presenting an expired credential were both independently detected and rejected, and a credential's issuer cannot be spoofed by writing a different DID into the payload — verification always attributes the credential to whichever key actually signed it.

## 4. Key Management

Previously an open gap; now implemented and tested (11 additional tests in `test/recovery.test.js`, plus `scripts/demo-guardian-recovery.js`).

- **Storage**: `scripts/lib/keystore.js` encrypts a private key to a password-protected V3 keystore JSON file (the same format geth/MetaMask use) via `wallet.encrypt(password)`, and decrypts it back via `Wallet.fromEncryptedJson`.
- **Recovery from genuine key loss**: `EHRRegistry.sol` now includes guardian-based social recovery — `setGuardians(identity, guardians[], threshold)` (owner-only, set up in advance) and `approveRecovery(identity, proposedNewOwner)` (guardian-only; executes automatically once the M-of-N threshold is met). This is the same trust-delegation concept already used for use case (iv), applied to the "the key itself is gone" scenario that plain `changeOwner` cannot handle (it requires a signature from the very key assumed lost).

**In-line text for the paper:**
> Key management is addressed via two complementary mechanisms. First, at-rest key storage uses a standard, password-encrypted keystore file (the V3 format used by geth and MetaMask), so the raw private key is never persisted unencrypted. Second, recovery from genuine key loss — as opposed to the delegation/revocation already covered in use cases (ii)-(iv) — is handled by a guardian-based social recovery extension: a patient or physician pre-registers a set of $N$ guardians and an approval threshold $M$; if the private key is later lost entirely, any $M$ of the $N$ guardians can jointly authorize moving the identity to a new address, verified in an 11-test adversarial suite covering unauthorized approval attempts, double-voting by a single guardian, and confirmation that the old key is powerless immediately after recovery executes.

## Limitations to state explicitly in the paper

- All measurements are from a **local Hardhat network**, not a public testnet or mainnet. Gas costs transfer directly (same EVM), but latency/throughput numbers are a local proxy, not a live-network claim.
- IPFS storage uses an in-process Helia node with no persistent pinning — adequate for measuring the storage/retrieval mechanism, not for demonstrating long-term off-chain durability.
- No formal contract audit was performed.
- Guardian recovery has no time-lock/veto window (recovery executes the instant the threshold is met) — a real deployment would likely add a delay during which the legitimate owner could cancel a fraudulent recovery attempt.
