const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Local key storage: a password-encrypted "V3 keystore" JSON file, the same
// format used by geth/MetaMask (PBKDF2/scrypt-derived key wrapping the raw
// private key). This is the "how is the key stored" half of key management;
// scripts/demo-guardian-recovery.js covers the "how is it recovered if truly
// lost" half via on-chain guardian approval.

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
