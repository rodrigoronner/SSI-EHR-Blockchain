const crypto = require("crypto");
const { loadDeployment, getProvider, getActors, createNonceTracker } = require("./lib/network");
const { buildEthrResolver, resolveAsOfChainHead } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");

// Demonstrates the paper's off-chain storage design (Section "Architecture
// of the Proposed Framework"): a medical document is encrypted, stored on
// IPFS, and only its content-addressed CID is anchored on-chain via the
// patient's DID attribute. A second party (another doctor) retrieves the
// CID from the chain, fetches the encrypted bytes from IPFS, and decrypts
// them — proving the round trip preserves integrity without ever putting
// the document itself on-chain.
//
// `helia`/`@helia/unixfs` are ESM-only packages; this script is CommonJS
// (matching the rest of the project), so they are loaded via dynamic
// `import()` rather than `require()`.

const SYNTHETIC_RECORD = JSON.stringify(
  {
    notice: "SYNTHETIC test data — not a real patient record.",
    patientDid: null, // filled in at runtime
    exam: "Complete Blood Count",
    result: "Within normal reference ranges.",
    issuedBy: null, // filled in at runtime
    issuedAt: new Date().toISOString(),
  },
  null,
  2
);

function encrypt(plaintextBuffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack iv | authTag | ciphertext into a single blob for storage.
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decrypt(blob, key) {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function heading(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  const { createHelia } = await import("helia");
  const { unixfs } = await import("@helia/unixfs");
  const { CID } = await import("multiformats/cid");

  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const nextNonce = createNonceTracker(provider);

  const doctorDid = makeEthrDid(actors.doctor, deployment);
  const patientDid = makeEthrDid(actors.patient, deployment);
  const secondDoctorDid = makeEthrDid(actors.stranger, deployment); // acting as another treating physician

  heading("Encrypting the synthetic medical record");
  const recordJson = SYNTHETIC_RECORD.replace('"patientDid": null', `"patientDid": ${JSON.stringify(patientDid.did)}`)
    .replace('"issuedBy": null', `"issuedBy": ${JSON.stringify(doctorDid.did)}`);
  const plaintext = Buffer.from(recordJson, "utf8");
  const encryptionKey = crypto.randomBytes(32); // AES-256 key; out-of-band exchange is out of scope for this PoC
  const encryptedBlob = encrypt(plaintext, encryptionKey);
  console.log(`Plaintext size: ${plaintext.length} bytes, encrypted blob size: ${encryptedBlob.length} bytes`);

  heading("Storing the encrypted blob on IPFS (local Helia node)");
  const helia = await createHelia();
  const fs = unixfs(helia);
  const cid = await fs.addBytes(encryptedBlob);
  console.log("Stored under CID:", cid.toString());

  heading("Anchoring the CID on-chain via the patient's DID attribute");
  const recordId = "exam-2026-07-28";
  await patientDid.setAttribute(`ehr/doc/${recordId}`, cid.toString(), 365 * 24 * 60 * 60, undefined, {
    nonce: await nextNonce(actors.patient.address),
  });
  console.log(`Attribute "ehr/doc/${recordId}" set to CID ${cid.toString()}`);

  heading("Second doctor: reading the CID back from chain history");
  const ethrResolver = buildEthrResolver(deployment);
  const address = patientDid.did.split(":").pop();
  const { history } = await ethrResolver.changeLog(address, "ehr-local", "latest");
  const attributeEvent = history
    .filter((event) => event.eventType === "DIDAttributeChanged" && event.name === `ehr/doc/${recordId}`)
    .pop();
  if (!attributeEvent) {
    throw new Error("Could not find the attribute event we just published — something is wrong.");
  }
  // Attribute values are stored on-chain as raw bytes (hex-encoded UTF-8 of
  // whatever string was passed to setAttribute); decode back to the CID string.
  const retrievedCid = Buffer.from(attributeEvent.value.replace(/^0x/, ""), "hex").toString("utf8");
  console.log(`${secondDoctorDid.did.slice(0, 24)}... found CID on-chain:`, retrievedCid);

  heading("Fetching from IPFS and decrypting");
  const chunks = [];
  for await (const chunk of fs.cat(CID.parse(retrievedCid))) {
    chunks.push(chunk);
  }
  const fetchedBlob = Buffer.concat(chunks);
  const decrypted = decrypt(fetchedBlob, encryptionKey); // key shared out-of-band in a real system
  const roundTripOk = decrypted.equals(plaintext);
  console.log("Decrypted content matches original plaintext:", roundTripOk);
  console.log(decrypted.toString("utf8"));

  if (!roundTripOk) {
    throw new Error("Round-trip integrity check failed.");
  }

  await helia.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
