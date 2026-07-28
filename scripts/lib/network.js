const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Same mnemonic Hardhat's built-in network uses by default for `npx hardhat
// node` (documented, well-known, local-testing-only). Deriving actors from it
// (instead of hardcoding private keys) keeps this file self-contained and
// avoids depending on `hre` from plain Node scripts.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

const DEPLOYMENT_FILE = path.join(__dirname, "..", "..", "deployment.json");

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(
      "deployment.json not found. Start a local node (`npm run node`) and deploy the contract " +
        "(`npm run deploy`) before running this script."
    );
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
}

function getProvider(deployment) {
  return new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
    staticNetwork: true,
    // ethers' default 250ms de-dup cache on identical JSON-RPC requests
    // (e.g. `getBlock("latest")`) can return a block that predates a
    // transaction we ourselves just confirmed moments earlier through the
    // same provider — exactly the kind of staleness that would make a
    // demo/benchmark's "read state right after this write" pattern flaky.
    // Disabled since correctness matters far more here than shaving off a
    // handful of duplicate local RPC calls.
    cacheTimeout: -1,
    // ethers' default 4000ms polling interval is how `tx.wait()` notices a
    // transaction was mined when the provider isn't using push-based
    // subscriptions (our plain HTTP JsonRpcProvider isn't). That default is
    // larger than most of what we're trying to *measure* here (e.g. a 2s
    // mining interval), so left alone it would dominate latency benchmarks
    // instead of the chain's actual confirmation time.
    pollingInterval: 50,
  });
}

function deriveWallet(index, provider) {
  const wallet = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return provider ? wallet.connect(provider) : wallet;
}

// Named actors used consistently across the demo, VC, IPFS and benchmark
// scripts so runs are easy to follow and reproduce.
function getActors(provider) {
  return {
    patient: deriveWallet(0, provider),
    doctor: deriveWallet(1, provider),
    hospital: deriveWallet(2, provider),
    investor: deriveWallet(3, provider),
    guardianDelegate: deriveWallet(4, provider),
    stranger: deriveWallet(5, provider),
  };
}

// EthrDID (and our own benchmark scripts) leave nonce resolution to the
// provider's "pending" transaction count on each send. Under Hardhat's
// automine, firing several sends from the same account in quick succession
// can race ahead of that count being reflected between calls, causing
// spurious "nonce too low" errors. Tracking nonces locally per address (seed
// once from chain, then increment in-memory) avoids that class of bug for
// both the demo script (sequential sends) and the benchmark scripts
// (concurrent sends).
function createNonceTracker(provider) {
  const next = new Map();
  return async function nextNonce(address) {
    const key = address.toLowerCase();
    if (!next.has(key)) {
      next.set(key, await provider.getTransactionCount(address, "pending"));
    }
    const nonce = next.get(key);
    next.set(key, nonce + 1);
    return nonce;
  };
}

module.exports = { HARDHAT_MNEMONIC, loadDeployment, getProvider, deriveWallet, getActors, createNonceTracker };
