const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");
const { encrypt, decrypt } = require("../scripts/lib/aesgcm");
const { KEYSTORE_DIR, saveKeystore, loadKeystore } = require("../scripts/lib/keystore");

// The off-chain half of the security analysis: integrity of documents stored
// on IPFS, and at-rest protection of the private key. Both used to be shown
// only by the demo scripts; these tests make them part of `npm test`.

describe("Off-chain documents and key storage", function () {
  this.timeout(60000);

  describe("encrypted documents on IPFS", function () {
    let helia;
    let heliaFs;

    before(async function () {
      // helia and @helia/unixfs are ESM-only, hence the dynamic import().
      const { createHelia } = await import("helia");
      const { unixfs } = await import("@helia/unixfs");
      helia = await createHelia();
      heliaFs = unixfs(helia);
    });

    after(async function () {
      await helia.stop();
    });

    async function fetchByCid(cid) {
      const chunks = [];
      for await (const chunk of heliaFs.cat(cid)) chunks.push(chunk);
      return Buffer.concat(chunks);
    }

    it("returns the original bytes when a document is fetched by its CID and decrypted", async function () {
      const key = crypto.randomBytes(32);
      const document = Buffer.from(JSON.stringify({ result: "Within normal reference ranges." }));
      const cid = await heliaFs.addBytes(encrypt(document, key));

      const retrieved = await fetchByCid(cid);
      expect(decrypt(retrieved, key).equals(document)).to.equal(true);
    });

    it("refuses to decrypt a ciphertext altered after encryption [adversarial]", async function () {
      const key = crypto.randomBytes(32);
      const blob = encrypt(Buffer.from("lab result"), key);
      blob[blob.length - 1] ^= 0x01; // flip one bit of the ciphertext
      expect(() => decrypt(blob, key)).to.throw(/unable to authenticate data|auth/i);
    });

    it("refuses to decrypt a document with any key but the one it was encrypted under [adversarial]", async function () {
      const blob = encrypt(Buffer.from("lab result"), crypto.randomBytes(32));
      expect(() => decrypt(blob, crypto.randomBytes(32))).to.throw(/unable to authenticate data|auth/i);
    });

    it("gives an altered document a different CID, so it cannot pass as the anchored one", async function () {
      const key = crypto.randomBytes(32);
      const blob = encrypt(Buffer.from("lab result"), key);
      const tampered = Buffer.from(blob);
      tampered[tampered.length - 1] ^= 0x01;
      const original = await heliaFs.addBytes(blob);
      const altered = await heliaFs.addBytes(tampered);
      expect(altered.toString()).to.not.equal(original.toString());
    });
  });

  describe("private key storage", function () {
    const filename = `test-${process.pid}.json`;

    after(function () {
      fs.rmSync(path.join(KEYSTORE_DIR, filename), { force: true });
    });

    it("stores the key only in encrypted form and recovers it with the right password", async function () {
      const wallet = ethers.Wallet.createRandom();
      const filePath = await saveKeystore(wallet, "correct horse battery staple", filename);

      const onDisk = fs.readFileSync(filePath, "utf8");
      expect(onDisk).to.not.include(wallet.privateKey.slice(2));
      const restored = await loadKeystore(filename, "correct horse battery staple");
      expect(restored.address).to.equal(wallet.address);
    });

    it("rejects a wrong password [adversarial]", async function () {
      let error;
      try {
        await loadKeystore(filename, "wrong password");
      } catch (e) {
        error = e;
      }
      expect(error, "loading with a wrong password should fail").to.exist;
    });
  });
});
