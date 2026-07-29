const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Hardhat's default mnemonic for `npx hardhat node` — public, local-only.
// Deriving accounts from it keeps these scripts independent of `hre`.
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
    // Ethers caches identical RPC calls for 250ms by default, which can
    // return a stale `getBlock("latest")` right after our own transaction.
    cacheTimeout: -1,
    // Default polling is 4s — too slow for the sub-2s block times we
    // benchmark against, and it would dominate the latency numbers.
    pollingInterval: 50,
  });
}

function deriveWallet(index, provider) {
  const wallet = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return provider ? wallet.connect(provider) : wallet;
}

// Named actors shared across the demo, VC, IPFS and benchmark scripts.
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

// Firing several sends from the same account back to back can outrun the
// provider's "pending" nonce count and throw "nonce too low". Track nonces
// locally instead: seed once from chain, then increment in memory.
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
