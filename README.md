# SSI-EHR-Blockchain

A working implementation of a self-sovereign identity (SSI) framework for Electronic Health Records, built on Ethereum. Patients, physicians, and hospitals each hold a Decentralized Identifier (DID) they control directly, medical operations are issued and verified as signed Verifiable Credentials (VCs), and clinical documents are encrypted and kept off-chain on IPFS, with only their hash anchored on the blockchain.

The goal is to move EHR access control away from a central database that a single institution can lose, leak, or lock a patient out of, and put it under a mechanism where ownership, delegation, and revocation are enforced by a smart contract instead of an administrator's discretion.

This repository is the reference implementation behind the paper *"Self-Sovereign Identity Management through Decentralized Identifiers and Verifiable Credentials"*. Every number quoted in the paper's Cost, Performance, and Security sections was produced by the scripts and tests in this repo, and they're included here so the results can be reproduced independently.

## What it does

- **Identity**: every actor gets a `did:ethr` identity anchored on-chain — created implicitly from an Ethereum address, no registration step or central issuer required.
- **Ownership transfer**: a DID's controlling key can change (e.g. a hospital entity acquired by a new owner) without the identifier itself changing.
- **Delegation**: an identity owner can grant another address time-bounded authority over part of their identity — for example, a parent delegating a child's identity to a temporary caregiver, with automatic expiry so nothing needs to be manually revoked later.
- **Attributes**: an identity can publish attributes such as a service endpoint or a document reference, each with its own validity period, and revoke them immediately if needed.
- **Verifiable Credentials**: clinical actions (a lab request, a prescription) are issued as signed VC-JWTs tied to the issuing DID, so any third party can verify who issued them and that they haven't been tampered with — no shared database required.
- **Off-chain storage**: documents are encrypted client-side, stored on IPFS, and referenced on-chain only by their CID, keeping large or sensitive payloads off the blockchain while preserving verifiability.
- **Guardian-based recovery**: an identity owner can register a set of trusted guardians ahead of time; if their private key is later lost, a threshold of guardians can jointly restore access to a new key, which a simple ownership transfer cannot do on its own.

## Architecture

Everything on-chain runs through a single smart contract, `EHRRegistry.sol`, which implements the same interface as the ERC-1056 `EthereumDIDRegistry`. That's a deliberate choice: it means standard `ethr-did` / `ethr-did-resolver` tooling can resolve DIDs against this contract with no custom resolver logic.

The contract itself never stores document contents or attribute values — only events. A DID Document is reconstructed by a resolver walking the event log backwards from the identity's most recent change. This keeps writes cheap and keeps the contract's job narrow: proving who controls an identity and what they've published, not storing the data itself.

```
Patient / Physician / Hospital
        │  (own an Ethereum key)
        ▼
   did:ethr identity  ──────────────►  EHRRegistry.sol (on-chain)
        │                                 owner, delegates, attributes,
        │                                 guardians — all event-sourced
        ▼
 Verifiable Credential (VC-JWT)
   signed by the DID's key
        │
        ▼
 Encrypted document ──► IPFS (off-chain) ──► CID anchored as a DID attribute
```

A guardian-recovery extension sits alongside the core registry: guardians are registered while the owner's key still works, and a threshold of them can later move a compromised or lost identity to a new address without ever needing the old key.

## Stack

- **Smart contract**: Solidity, `EHRRegistry.sol` — ERC-1056-compatible DID registry plus the guardian-recovery extension.
- **Development and testing**: Hardhat, `@nomicfoundation/hardhat-toolbox`, ethers.js.
- **DID / Verifiable Credentials**: `ethr-did`, `ethr-did-resolver`, `did-resolver`, `did-jwt`, `did-jwt-vc`.
- **Off-chain storage**: `helia` + `@helia/unixfs` (an embeddable IPFS node — no external daemon to run), AES-256-GCM for client-side encryption.

All dependency versions are pinned in `package.json` so results are reproducible on a given clone.

## Repository layout

```
contracts/EHRRegistry.sol   the on-chain registry
scripts/                    demos and benchmarks (see below)
scripts/lib/                shared helpers: network/provider setup, DID resolution, keystore handling
test/                       automated test suite (Hardhat + Mocha/Chai)
results/                    measured cost, performance, and security results (JSON/CSV + write-ups)
```

## Getting started

```bash
npm install
npx hardhat compile
```

Start a local Ethereum node and leave it running:

```bash
npm run node
```

In a second terminal, deploy the contract and try the demos:

```bash
npm run deploy       # deploys EHRRegistry, writes deployment.json
npm run demo         # the core identity use cases end to end
npm run vc-demo      # issue, verify, tamper, and expire a Verifiable Credential
npm run ipfs-demo    # encrypt a document, store it on IPFS, anchor its CID on-chain, retrieve and decrypt it
npm run recovery-demo # encrypted keystore + guardian-based social recovery
```

Each demo shares state with the others through the same deployed contract, so if you run several back to back and something looks off (an identity's owner already changed, for instance), redeploy first with `npm run deploy`.

To run the automated test suite instead (self-contained, no local node required):

```bash
npm test
```

## Results

Cost, performance, and security were all measured, not just discussed. Full data is in `results/`:

- `results/cost-evaluation.{json,csv}` — gas cost per operation, converted to USD at a representative gas price.
- `results/performance-evaluation.{json,csv}` — confirmation latency across different block-time configurations, and throughput under concurrent load.
- `results/security-analysis.md` — every access-control, revocation, and credential-integrity requirement mapped to the adversarial test that exercises it.
- `results/SUMMARY.md` — all of the above consolidated.

A few headline numbers (see the paper for full methodology): core identity operations cost between $2.08 and $4.33 per call at 20 gwei; confirmation latency tracks the underlying network's block time almost exactly (38 ms under instant mining, ~4 s at a 4-second block interval); on-chain throughput reaches close to 300 tx/s under concurrent load; and a 33-case adversarial test suite covering access control, revocation, credential tampering, and guardian recovery passes in full.

## Key management

An identity's private key is stored as a password-encrypted keystore file, the same V3 format used by geth and MetaMask — the raw key is never written to disk unencrypted. That covers day-to-day storage, but doesn't help if the key is genuinely lost. For that, `EHRRegistry.sol` includes a guardian-based social recovery mechanism: an owner registers a set of guardians and an approval threshold in advance, and if the key is later lost, that threshold of guardians can jointly move the identity to a new address without any signature from the lost key. See `test/recovery.test.js` and `npm run recovery-demo`.

## Known limitations

- All measurements come from a local Hardhat network rather than a public testnet or mainnet. Gas costs transfer directly (same EVM), but latency and throughput should be read as a local proxy, not a mainnet claim.
- The IPFS node used here is in-process and non-persistent — there's no pinning service behind it.
- The contract has not been through a formal security audit.
- Guardian recovery executes as soon as the approval threshold is met, with no time-lock or veto window for the legitimate owner to cancel a fraudulent attempt.

## Paper

This code accompanies:

> Tertulino, R., Vidal, F., Ivaki, N. *Self-Sovereign Identity Management through Decentralized Identifiers and Verifiable Credentials.*

If you use this repository in academic work, please cite the paper above.
