# SSI-EHR-Blockchain

Reference implementation and experiments for the paper's SSI/DID/VC framework for EHRs (Ethereum `did:ethr` + Verifiable Credentials + IPFS). Provides the real, measured results behind the paper's "Cost Evaluation", "Performance Evaluation" and "Security Analysis" sections, plus a guardian-based key-recovery mechanism.

## Stack

- **Contract**: `contracts/EHRRegistry.sol` — an ERC-1056-compatible DID registry (same interface as the reference `EthereumDIDRegistry`), so standard `ethr-did` / `ethr-did-resolver` tooling resolves `did:ethr` DID Documents against it directly.
- **Dev/test**: Hardhat 2.29 + `@nomicfoundation/hardhat-toolbox` 5 + ethers 6.
- **DID/VC**: `ethr-did`, `ethr-did-resolver`, `did-resolver`, `did-jwt`, `did-jwt-vc`.
- **Off-chain storage**: `helia` + `@helia/unixfs` (in-process IPFS node, no external daemon needed), AES-256-GCM encryption via Node's `crypto`.

All dependency versions are pinned in `package.json` for reproducibility.

## Setup

```bash
npm install
npx hardhat compile
```

## Running things

Every script below (except `npx hardhat test`) talks to a **persistent** local node over JSON-RPC, not Hardhat's ephemeral in-process test network. Start one first:

```bash
npm run node        # terminal 1 — leave running
```

Then, in a second terminal, **redeploy before each script/benchmark you run** — several of them use `changeOwner`/`setAttribute` on shared demo identities, and running multiple scripts back-to-back against the same deployment can leave one script's state affecting another's assumptions (e.g. an identity's ownership already transferred by a previous run):

```bash
npm run deploy       # writes deployment.json with the fresh contract address
npm run demo         # the 4 use cases from the paper's Introduction, end to end
npm run vc-demo      # EHR Operation Verifiable Credential: issue, verify, tamper, expire
npm run ipfs-demo    # encrypt -> store on IPFS -> anchor CID on-chain -> retrieve -> decrypt
npm run bench:cost        # Cost Evaluation -> results/cost-evaluation.{json,csv}
npm run bench:performance # Performance Evaluation -> results/performance-evaluation.{json,csv}
npm run recovery-demo     # Key management: encrypted keystore + guardian-based social recovery
```

`npm run recovery-demo` writes password-encrypted keystore files to `keystores/` (gitignored-worthy — they're local demo artifacts, not secrets, but treat real ones as secrets).

Automated test suite (self-contained, deploys its own throwaway contract per test, no running node needed):

```bash
npm test
```

## Results

- `results/cost-evaluation.{json,csv}` — gas/ETH/USD per operation.
- `results/performance-evaluation.{json,csv}` — latency (auto-mine vs. fixed block intervals) and throughput under concurrent load.
- `results/security-analysis.md` — requirement-by-requirement adversarial test mapping.
- `results/SUMMARY.md` — everything above consolidated into LaTeX-ready tables and paper-ready prose.

## Key management

`contracts/EHRRegistry.sol` includes guardian-based social recovery (`setGuardians` / `approveRecovery`): a pre-registered M-of-N guardian set can move a lost identity to a new address without the old key, which plain `changeOwner` cannot do since it requires a signature from the very key assumed lost. `scripts/lib/keystore.js` covers the complementary "how is the key stored" half via a password-encrypted V3 keystore file (geth/MetaMask format). See `test/recovery.test.js` (11 tests) and `npm run recovery-demo`.

## Known limitations (also stated in `results/SUMMARY.md`)

- All measurements are from a local Hardhat network, not a public testnet/mainnet — gas costs transfer directly (same EVM), latency/throughput are a local proxy.
- IPFS storage uses an in-process, non-persistent Helia node (no pinning service).
- No formal audit of `EHRRegistry.sol` was performed.
- Guardian recovery has no time-lock/veto window — recovery executes the instant the threshold is met.

## A debugging note worth knowing if you extend this

Two ethers v6 defaults caused resolution/timing to look broken during development and are worth knowing about if you build on this:

1. `JsonRpcProvider`'s default 250ms request cache can serve a `getBlock("latest")` that predates a transaction confirmed moments earlier through the same provider. Fixed via `cacheTimeout: -1` in `scripts/lib/network.js`'s `getProvider()`.
2. `JsonRpcProvider`'s default 4000ms `pollingInterval` is how `tx.wait()` notices a mined transaction (no push-based subscriptions over plain HTTP) — it will dominate any latency measurement smaller than ~4s if left at default. Fixed via `pollingInterval: 50` in the same place.

Separately, `ethr-did-resolver`'s DID Document construction compares each event's block timestamp against **real wall-clock time**, not the local chain's simulated clock. `scripts/lib/resolver.js`'s `resolveAsOfChainHead` resolves "as of" the chain's own latest block timestamp instead, so demo output showing delegate/attribute revocations is deterministic regardless of how fast the local chain's simulated clock has drifted from real time.
