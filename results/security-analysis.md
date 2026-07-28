# Security Analysis

Evidence for this section comes from four automated test suites (`npx hardhat test`, 33/33 passing) plus the standalone `scripts/ipfs-store.js` round-trip check. Every requirement listed in the paper's Section "Security and Privacy Requirements in EHRs" is exercised by at least one adversarial or lifecycle test below, not just asserted in prose.

| Requirement (paper Section 3) | Test | Result |
|---|---|---|
| Access control — only the identity owner may transfer ownership | `test/security.test.js`: *"an attacker cannot transfer ownership of an identity they do not control"* | PASS — reverts with `EHRRegistry: not authorized`; owner unchanged |
| Access control — only the identity owner may authorize a delegate | `test/security.test.js`: *"an attacker cannot grant themselves as a delegate on another identity"* | PASS — reverts; `validDelegate` stays `false` |
| Access control — only the identity owner may revoke a delegate | `test/security.test.js`: *"an attacker cannot revoke a legitimate delegate on another identity"* | PASS — reverts; the legitimate delegate's authorization is left intact (attacker cannot even harm it) |
| Access control — only the identity owner may publish/revoke attributes (service endpoints, document hashes) | `test/security.test.js`: *"an attacker cannot publish or revoke attributes on another identity"* | PASS — reverts |
| Patient consent has a natural expiry (delegated authorization is time-bounded, not indefinite) | `test/security.test.js`: *"a delegate's authorization expires on its own after the granted validity period"* | PASS — `validDelegate` flips to `false` once the granted period elapses, with no further transaction required |
| Verifiable, immediate revocation (explicit revocation does not wait for natural expiry) | `test/security.test.js`: *"revoking a delegate takes effect immediately"*; `EHRRegistry.test.js`: *"revokeAttribute emits validTo = 0"* | PASS |
| Audit control — every identity mutation is independently auditable | `test/security.test.js`: *"every ownership/delegate/attribute change is independently auditable via on-chain events"* | PASS — `DIDOwnerChanged`/`DIDDelegateChanged`/`DIDAttributeChanged` events carry the full before/after state |
| Data integrity of off-chain (IPFS) documents | `scripts/ipfs-store.js` | PASS — decrypted content retrieved via the on-chain CID is byte-identical to the original plaintext; IPFS's own content-addressing means a tampered blob could not be retrieved under the same CID at all |
| Credential integrity — a VC cannot be altered after issuance without detection | `test/vc.test.js`: *"rejects a VC whose payload was tampered with after signing"* | PASS — signature verification fails (`invalid_signature`) |
| Credential integrity — an expired VC is not accepted | `test/vc.test.js`: *"rejects a VC that has already expired"* | PASS |
| Issuer authenticity — a VC's issuer cannot be spoofed by writing another DID into the payload | `test/vc.test.js`: *"cannot be forged by putting the doctor's DID in the payload and signing with a different key"* | PASS — verification attributes the credential to whoever actually signed it, not whoever the payload claims |
| Key management — private key storage | `scripts/lib/keystore.js` (via `scripts/demo-guardian-recovery.js`) | PASS — key encrypted to a password-protected V3 keystore file (geth/MetaMask format) and successfully decrypted back with the correct password |
| Key management — recovery from genuine key loss (not merely revocation/delegation, which are covered above) | `test/recovery.test.js`, `scripts/demo-guardian-recovery.js` | PASS — a pre-registered M-of-N guardian set (11 tests) can jointly move a lost identity to a new address without the old key; a single guardian cannot act alone or double-vote; the old key is provably powerless immediately after recovery |

## Interpretation

All access-control checks are enforced entirely on-chain by the `onlyOwner` modifier in `EHRRegistry.sol` — there is no off-chain gatekeeper to bypass. Delegation is time-bounded by construction (`addDelegate` always takes a validity period), so a forgotten revocation degrades to "no access" rather than "permanent access," which is the safer failure mode for a healthcare access-control system. Verifiable Credentials add a second, independent integrity layer on top of the registry: even if a VC is copied and passed around off-chain, tampering or forgery is cryptographically detectable without needing to touch the blockchain at all.

Key management — previously an open gap — is now addressed by two complementary mechanisms: (1) at-rest storage via a standard, password-encrypted keystore file, so the raw private key is never persisted in the clear; and (2) recovery from genuine, total key loss via a guardian-based social recovery extension to `EHRRegistry.sol` (`setGuardians`/`approveRecovery`), modeled directly on the same trust-delegation concept already used for use case (iv). Recovery clears the guardian set on execution, so the new owner must deliberately re-authorize guardians rather than silently inheriting a potentially stale or compromised set.

## Known limitations (not covered by this PoC)

- No formal verification or third-party audit of `EHRRegistry.sol` was performed; the contract closely mirrors the widely-used ERC-1056 reference implementation, but that is not a substitute for an audit.
- Denial-of-service / gas-griefing resistance was not tested (e.g., no protection is needed against unbounded loops since the contract has none, but this was not adversarially probed).
- Guardian recovery has no time-lock or veto window: recovery executes the instant the threshold is met. A real deployment would likely want a delay (during which the legitimate owner, if not actually compromised, could cancel it) to defend against a majority of guardians colluding or being compromised.
- The guardian-approval flow does not yet support removing a single guardian's stale approval for a *different* proposed address without waiting for it to naturally lose relevance; this is a usability rather than a security gap.
