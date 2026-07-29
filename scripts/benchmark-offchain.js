const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");
const { loadDeployment, getProvider, getActors } = require("./lib/network");
const { buildResolver } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");

// Off-chain latency numbers to go with the on-chain ones. No blockchain
// transaction is involved here, so none of this costs gas.
//
// The IPFS path is swept across document sizes, from a small text report to
// an imaging-sized file, because that is the axis that actually matters:
// the on-chain cost of anchoring a CID is flat regardless of payload, but
// the off-chain store/retrieve cost is not. Encryption and decryption are
// timed separately from the IPFS calls so each stage can be reported on its
// own rather than folded into one number.

const VC_TRIALS = 10;

// Trial counts taper as documents grow: the large sizes are slow enough
// that their variance is already small, and every trial holds another copy
// in the in-memory blockstore.
const SIZES = [
  { label: "80 B", bytes: 80, trials: 10 },
  { label: "10 KB", bytes: 10 * 1024, trials: 10 },
  { label: "100 KB", bytes: 100 * 1024, trials: 10 },
  { label: "1 MB", bytes: 1024 * 1024, trials: 10 },
  { label: "10 MB", bytes: 10 * 1024 * 1024, trials: 5 },
  { label: "50 MB", bytes: 50 * 1024 * 1024, trials: 3 },
];

function summarizeMs(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    meanMs: Number(mean.toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

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

async function benchmarkIpfs() {
  const { createHelia } = await import("helia");
  const { unixfs } = await import("@helia/unixfs");
  const { CID } = await import("multiformats/cid");

  const helia = await createHelia();
  const heliaFs = unixfs(helia);
  const bySize = [];

  // Untimed warm-up, for the same reason as the VC benchmark below: without
  // it the first size measured absorbs Helia's one-off initialisation and
  // reads as slower than the larger sizes after it, which inverts the curve
  // at the low end. A single small warm-up is not enough to settle this;
  // measuring 80 B first versus last differed by 7x until the warm-up below
  // was extended to several iterations at a size large enough to exercise
  // chunking, the blockstore, and the cipher paths.
  for (let i = 0; i < 5; i++) {
    const warmupKey = crypto.randomBytes(32);
    const warmupBlob = encrypt(crypto.randomBytes(1024 * 1024), warmupKey);
    const warmupCid = await heliaFs.addBytes(warmupBlob);
    const warmupChunks = [];
    for await (const chunk of heliaFs.cat(warmupCid)) warmupChunks.push(chunk);
    decrypt(Buffer.concat(warmupChunks), warmupKey);
  }

  for (const size of SIZES) {
    const encryptMs = [];
    const storeMs = [];
    const retrieveMs = [];
    const decryptMs = [];

    for (let i = 0; i < size.trials; i++) {
      // Random bytes stand in for a real document: whatever the plaintext
      // is, what reaches IPFS is ciphertext, which is incompressible.
      const plaintext = crypto.randomBytes(size.bytes);
      const key = crypto.randomBytes(32);

      const t0 = performance.now();
      const encrypted = encrypt(plaintext, key);
      encryptMs.push(performance.now() - t0);

      const t1 = performance.now();
      const cid = await heliaFs.addBytes(encrypted);
      storeMs.push(performance.now() - t1);

      const t2 = performance.now();
      const chunks = [];
      for await (const chunk of heliaFs.cat(CID.parse(cid.toString()))) chunks.push(chunk);
      const fetched = Buffer.concat(chunks);
      retrieveMs.push(performance.now() - t2);

      const t3 = performance.now();
      const recovered = decrypt(fetched, key);
      decryptMs.push(performance.now() - t3);

      if (!recovered.equals(plaintext)) {
        throw new Error(`Round-trip integrity check failed at ${size.label}`);
      }
    }

    const store = summarizeMs(storeMs);
    const retrieve = summarizeMs(retrieveMs);
    bySize.push({
      label: size.label,
      bytes: size.bytes,
      trials: size.trials,
      encrypt: summarizeMs(encryptMs),
      store,
      retrieve,
      decrypt: summarizeMs(decryptMs),
      // Sustained throughput is the more meaningful figure once documents
      // are large enough for the fixed per-call overhead to stop dominating.
      storeMbPerS: Number((size.bytes / 1048576 / (store.meanMs / 1000)).toFixed(2)),
      retrieveMbPerS: Number((size.bytes / 1048576 / (retrieve.meanMs / 1000)).toFixed(2)),
    });

    console.log(
      `${size.label.padEnd(7)} (n=${size.trials})  encrypt=${summarizeMs(encryptMs).meanMs}ms` +
        `  store=${store.meanMs}ms  retrieve=${retrieve.meanMs}ms  decrypt=${summarizeMs(decryptMs).meanMs}ms`
    );
  }

  await helia.stop();
  return { bySize };
}

async function benchmarkVc() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const resolver = buildResolver(deployment);
  const doctorDid = makeEthrDid(actors.doctor, deployment);
  const patientDid = makeEthrDid(actors.patient, deployment);

  const signMs = [];
  const verifyMs = [];

  // One untimed warm-up pass: the first sign/verify pays JIT and lazy-module
  // costs that are not representative of steady-state behaviour.
  const warmupPayload = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ["VerifiableCredential", "EHROperationCredential"],
    issuer: { id: doctorDid.did },
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: patientDid.did, operation: "LabExamRequest", examType: "Complete Blood Count" },
  };
  await verifyCredential(await createVerifiableCredentialJwt(warmupPayload, doctorDid), resolver);

  for (let i = 0; i < VC_TRIALS; i++) {
    const payload = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ["VerifiableCredential", "EHROperationCredential"],
      issuer: { id: doctorDid.did },
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: patientDid.did, operation: "LabExamRequest", examType: "Complete Blood Count" },
    };

    const t0 = performance.now();
    const jwt = await createVerifiableCredentialJwt(payload, doctorDid);
    signMs.push(performance.now() - t0);

    const t1 = performance.now();
    await verifyCredential(jwt, resolver);
    verifyMs.push(performance.now() - t1);
  }

  return { sign: summarizeMs(signMs), verify: summarizeMs(verifyMs) };
}

async function main() {
  console.log("\n=== Off-chain Performance: IPFS encrypt/store/retrieve/decrypt by document size ===");
  const ipfs = await benchmarkIpfs();

  console.log(`\n=== Off-chain Performance: VC sign/verify (n=${VC_TRIALS}) ===`);
  const vc = await benchmarkVc();
  console.log(`sign     mean=${vc.sign.meanMs}ms  min=${vc.sign.minMs}ms  max=${vc.sign.maxMs}ms`);
  console.log(`verify   mean=${vc.verify.meanMs}ms  min=${vc.verify.minMs}ms  max=${vc.verify.maxMs}ms`);

  const report = { vcTrials: VC_TRIALS, ipfs, vc };
  fs.writeFileSync(
    path.join(__dirname, "..", "results", "offchain-performance.json"),
    JSON.stringify(report, null, 2) + "\n"
  );

  const csvLines = ["bytes,label,trials,encrypt_ms,store_ms,retrieve_ms,decrypt_ms,store_mb_per_s,retrieve_mb_per_s"];
  for (const row of ipfs.bySize) {
    csvLines.push(
      `${row.bytes},${row.label},${row.trials},${row.encrypt.meanMs},${row.store.meanMs},` +
        `${row.retrieve.meanMs},${row.decrypt.meanMs},${row.storeMbPerS},${row.retrieveMbPerS}`
    );
  }
  fs.writeFileSync(path.join(__dirname, "..", "results", "offchain-performance.csv"), csvLines.join("\n") + "\n");
  console.log("\nWrote results/offchain-performance.json and results/offchain-performance.csv");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
