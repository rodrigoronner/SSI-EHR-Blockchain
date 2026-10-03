const crypto = require("crypto");

// Client-side document encryption, shared by the IPFS demo, the off-chain
// benchmark, and the tests. AES-256-GCM is authenticated: decrypting a blob
// that was altered in any way throws instead of returning wrong plaintext.
// The 12-byte IV and 16-byte auth tag are packed in front of the ciphertext:
//   iv (12) | authTag (16) | ciphertext

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(blob, key) {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encrypt, decrypt };
