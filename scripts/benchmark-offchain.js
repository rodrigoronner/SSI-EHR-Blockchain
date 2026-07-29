const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");
const { loadDeployment, getProvider, getActors } = require("./lib/network");
const { buildResolver } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");
const { summarize, formatCi } = require("./lib/stats");

// Off-chain latency numbers to go with the on-chain ones. No blockchain
// transaction is involved here, so none of this costs gas.
//
// The IPFS path is swept across document sizes, from a small text report to
// an imaging-sized file, because that is the axis that actually matters:
// the on-chain cost of anchoring a CID is flat regardless of payload, but
// the off-chain store/retrieve cost is not. Encryption and decryption are
// timed separately from the IPFS calls so each stage can be reported on its
// own rather than folded into one number.

const VC_TRIALS = 30;

// Trial counts taper as documents grow, since every trial keeps another copy
// of the ciphertext in the in-memory blockstore. They are kept at 10 even at
// the largest size so that a confidence interval is still meaningful: below
// that, Student's t widens sharply (4.303 at n = 3 against 2.262 at n = 10)
// and the interval says more about the sample size than about the system.
// Run with --max-old-space-size=4096; the 50 MB row alone holds ~500 MB.
const SIZES = [
  { label: "80 B", bytes: 80, trials: 30 },
  { label: "10 KB", bytes: 10 * 1024, trials: 30 },
  { label: "100 KB", bytes: 100 * 1024, trials: 30 },
  { label: "1 MB", bytes: 1024 * 1024, trials: 20 },
  { label: "10 MB", bytes: 10 * 1024 * 1024, trials: 10 },
  { label: "50 MB", bytes: 50 * 1024 * 1024, trials: 10 },
];

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

    const encryptStats = summarize(encryptMs);
    const store = summarize(storeMs);
    const retrieve = summarize(retrieveMs);
    const decryptStats = summarize(decryptMs);

    // The round trip is a sum of four measured stages, so its uncertainty is
    // not the sum of theirs. Summing per-stage confidence intervals would
    // overstate it, since the stages do not deviate in lockstep. We instead
    // total the four stages within each trial and summarise that directly.
    const roundTripMs = encryptMs.map((_, i) => encryptMs[i] + storeMs[i] + retrieveMs[i] + decryptMs[i]);

    bySize.push({
      label: size.label,
      bytes: size.bytes,
      trials: size.trials,
      encrypt: encryptStats,
      store,
      retrieve,
      decrypt: decryptStats,
      roundTrip: summarize(roundTripMs),
      // Sustained throughput is the more meaningful figure once documents
      // are large enough for the fixed per-call overhead to stop dominating.
      // Derived from the mean, so no interval is attached to it.
      storeMbPerS: Number((size.bytes / 1048576 / (store.mean / 1000)).toFixed(2)),
      retrieveMbPerS: Number((size.bytes / 1048576 / (retrieve.mean / 1000)).toFixed(2)),
    });

    console.log(
      `${size.label.padEnd(7)} (n=${size.trials})  encrypt=${formatCi(encryptStats)}` +
        `  store=${formatCi(store)}  retrieve=${formatCi(retrieve)}  decrypt=${formatCi(decryptStats)}`
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

  return { sign: summarize(signMs), verify: summarize(verifyMs) };
}

async function main() {
  console.log("\n=== Off-chain Performance: IPFS encrypt/store/retrieve/decrypt by document size ===");
  console.log("(mean +/- half-width of the 95% confidence interval, Student's t)\n");
  const ipfs = await benchmarkIpfs();

  console.log(`\n=== Off-chain Performance: VC sign/verify (n=${VC_TRIALS}) ===`);
  const vc = await benchmarkVc();
  console.log(`sign     ${formatCi(vc.sign)}   [min ${vc.sign.min}, max ${vc.sign.max}]`);
  console.log(`verify   ${formatCi(vc.verify)}   [min ${vc.verify.min}, max ${vc.verify.max}]`);

  const report = { vcTrials: VC_TRIALS, confidenceLevel: 0.95, ipfs, vc };
  fs.writeFileSync(
    path.join(__dirname, "..", "results", "offchain-performance.json"),
    JSON.stringify(report, null, 2) + "\n"
  );

  const csvLines = [
    "bytes,label,n,encrypt_ms,encrypt_ci95,store_ms,store_ci95,retrieve_ms,retrieve_ci95," +
      "decrypt_ms,decrypt_ci95,round_trip_ms,round_trip_ci95,store_mb_per_s,retrieve_mb_per_s",
  ];
  for (const row of ipfs.bySize) {
    csvLines.push(
      `${row.bytes},${row.label},${row.trials},${row.encrypt.mean},${row.encrypt.ci95},` +
        `${row.store.mean},${row.store.ci95},${row.retrieve.mean},${row.retrieve.ci95},` +
        `${row.decrypt.mean},${row.decrypt.ci95},${row.roundTrip.mean},${row.roundTrip.ci95},` +
        `${row.storeMbPerS},${row.retrieveMbPerS}`
    );
  }
  fs.writeFileSync(path.join(__dirname, "..", "results", "offchain-performance.csv"), csvLines.join("\n") + "\n");
  console.log("\nWrote results/offchain-performance.json and results/offchain-performance.csv");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
