const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");
const { loadDeployment, getProvider, getActors } = require("./lib/network");
const { buildResolver } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");

// Off-chain performance metrics that complement the on-chain latency/
// throughput numbers: how long the framework's two off-chain building
// blocks (IPFS storage and VC issuance/verification) take in wall-clock
// time. Neither involves a blockchain transaction, so these are not gas
// costs; they are the other half of the end-to-end latency a user actually
// experiences (e.g., requesting a lab exam, Figure EHROperation).

const N_TRIALS = 10;
const SAMPLE_RECORD = Buffer.from(
  JSON.stringify({ notice: "SYNTHETIC test data", exam: "Complete Blood Count", result: "Normal" }),
  "utf8"
);

function summarizeMs(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    meanMs: Number(mean.toFixed(2)),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

async function benchmarkIpfs() {
  const { createHelia } = await import("helia");
  const { unixfs } = await import("@helia/unixfs");
  const { CID } = await import("multiformats/cid");

  const helia = await createHelia();
  const fs_ = unixfs(helia);

  const storeMs = [];
  const retrieveMs = [];

  for (let i = 0; i < N_TRIALS; i++) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(SAMPLE_RECORD), cipher.final(), cipher.getAuthTag()]);

    const t0 = performance.now();
    const cid = await fs_.addBytes(encrypted);
    storeMs.push(performance.now() - t0);

    const t1 = performance.now();
    const chunks = [];
    for await (const chunk of fs_.cat(CID.parse(cid.toString()))) chunks.push(chunk);
    void Buffer.concat(chunks);
    retrieveMs.push(performance.now() - t1);
  }

  await helia.stop();
  return { store: summarizeMs(storeMs), retrieve: summarizeMs(retrieveMs) };
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
  let lastJwt;

  for (let i = 0; i < N_TRIALS; i++) {
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
    lastJwt = jwt;

    const t1 = performance.now();
    await verifyCredential(jwt, resolver);
    verifyMs.push(performance.now() - t1);
  }

  void lastJwt;
  return { sign: summarizeMs(signMs), verify: summarizeMs(verifyMs) };
}

async function main() {
  console.log(`\n=== Off-chain Performance: IPFS store/retrieve (n=${N_TRIALS}) ===`);
  const ipfs = await benchmarkIpfs();
  console.log(`store    mean=${ipfs.store.meanMs}ms  min=${ipfs.store.minMs.toFixed(2)}ms  max=${ipfs.store.maxMs.toFixed(2)}ms`);
  console.log(`retrieve mean=${ipfs.retrieve.meanMs}ms  min=${ipfs.retrieve.minMs.toFixed(2)}ms  max=${ipfs.retrieve.maxMs.toFixed(2)}ms`);

  console.log(`\n=== Off-chain Performance: VC sign/verify (n=${N_TRIALS}) ===`);
  const vc = await benchmarkVc();
  console.log(`sign     mean=${vc.sign.meanMs}ms  min=${vc.sign.minMs.toFixed(2)}ms  max=${vc.sign.maxMs.toFixed(2)}ms`);
  console.log(`verify   mean=${vc.verify.meanMs}ms  min=${vc.verify.minMs.toFixed(2)}ms  max=${vc.verify.maxMs.toFixed(2)}ms`);

  const report = { nTrials: N_TRIALS, ipfs, vc };
  fs.writeFileSync(
    path.join(__dirname, "..", "results", "offchain-performance.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log("\nWrote results/offchain-performance.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
