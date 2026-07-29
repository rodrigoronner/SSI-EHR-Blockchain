const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Password-encrypted V3 keystore, same format geth/MetaMask use. Covers key
// storage; scripts/demo-guardian-recovery.js covers recovery if it's lost.

const KEYSTORE_DIR = path.join(__dirname, "..", "..", "keystores");

async function saveKeystore(wallet, password, filename) {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
  const json = await wallet.encrypt(password);
  const filePath = path.join(KEYSTORE_DIR, filename);
  fs.writeFileSync(filePath, json);
  return filePath;
}

async function loadKeystore(filename, password, provider) {
  const filePath = path.join(KEYSTORE_DIR, filename);
  const json = fs.readFileSync(filePath, "utf8");
  const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
  return provider ? wallet.connect(provider) : wallet;
}

module.exports = { KEYSTORE_DIR, saveKeystore, loadKeystore };
