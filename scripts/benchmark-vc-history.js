const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");
const { loadDeployment, getProvider, getActors, createNonceTracker } = require("./lib/network");
const { buildResolver } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");
const { summarizeLatency, formatCi } = require("./lib/stats");

// How Verifiable Credential verification scales with the issuer's history.
//
// Verifying a VC resolves the issuer's DID Document, and ethr-did-resolver
// rebuilds that document by walking the identity's event log backwards from
// its most recent change. Every change ever recorded against the issuer is
// therefore paid for again on each verification. This benchmark measures
// that effect directly: it grows the issuing physician's history in steps
// and times verification at each step, against a freshly deployed registry
// (run `npm run deploy` first, as for every benchmark).

const HISTORY_LEVELS = [0, 100, 250, 500];
const TRIALS_PER_LEVEL = 30;
const WARMUP_PASSES = 3;

const artifact = require("../artifacts/contracts/EHRRegistry.sol/EHRRegistry.json");

function credentialPayload(issuerDid, subjectDid) {
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ["VerifiableCredential", "EHROperationCredential"],
    issuer: { id: issuerDid.did },
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: subjectDid.did, operation: "LabExamRequest", examType: "Complete Blood Count" },
  };
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const resolver = buildResolver(deployment);
  const registry = new ethers.Contract(deployment.registryAddress, artifact.abi, provider);
  const nextNonce = createNonceTracker(provider);

  const doctorDid = makeEthrDid(actors.doctor, deployment);
  const patientDid = makeEthrDid(actors.patient, deployment);

  const startingChanges = await registry.changed(actors.doctor.address);
  if (startingChanges !== 0n) {
    throw new Error(
      "The issuer already has on-chain history, so the 0-change baseline would be wrong. " +
        "Redeploy the registry (`npm run deploy`) before running this benchmark."
    );
  }

  console.log("\n=== VC verification latency vs. the issuer's on-chain history ===");
  console.log(`(n=${TRIALS_PER_LEVEL} per level; mean +/- half-width of the 95% confidence interval, Student's t)\n`);

  let recorded = 0;
  const levels = [];
  for (const target of HISTORY_LEVELS) {
    // Each change is a distinct attribute, so the resolver has to walk and
    // process every one of them rather than collapsing repeated updates.
    while (recorded < target) {
      recorded += 1;
      const name = ethers.encodeBytes32String(`history-${recorded}`);
      const value = ethers.toUtf8Bytes(`history-value-${recorded}`);
      const tx = await registry
        .connect(actors.doctor)
        .setAttribute(actors.doctor.address, name, value, 3600, {
          nonce: await nextNonce(actors.doctor.address),
          gasLimit: 150000,
        });
      await tx.wait();
    }

    // Untimed warm-up at each level, so the first trials do not absorb JIT
    // or connection costs that the others do not pay. The first resolution
    // after the history grows is markedly slower than the rest.
    for (let w = 0; w < WARMUP_PASSES; w++) {
      await verifyCredential(await createVerifiableCredentialJwt(credentialPayload(doctorDid, patientDid), doctorDid), resolver);
    }

    const verifyMs = [];
    for (let i = 0; i < TRIALS_PER_LEVEL; i++) {
      const jwt = await createVerifiableCredentialJwt(credentialPayload(doctorDid, patientDid), doctorDid);
      const t0 = performance.now();
      await verifyCredential(jwt, resolver);
      verifyMs.push(performance.now() - t0);
    }
    // Percentiles are kept alongside the interval: the local node
    // occasionally stalls a single resolution for about a second, and the
    // median shows the typical cost where such a stall would inflate the mean.
    const verify = summarizeLatency(verifyMs, 3);
    levels.push({ priorChanges: target, verify });
    console.log(
      `${String(target).padStart(4)} prior changes   verify ${formatCi(verify)}   p50=${verify.p50}  p95=${verify.p95}  [min ${verify.min}, max ${verify.max}]`
    );
  }

  const baseline = levels[0].verify.p50;
  const report = {
    trialsPerLevel: TRIALS_PER_LEVEL,
    confidenceLevel: 0.95,
    levels: levels.map((l) => ({ ...l, medianRelativeToBaseline: Number((l.verify.p50 / baseline).toFixed(3)) })),
  };
  const resultsDir = path.join(__dirname, "..", "results");
  fs.writeFileSync(path.join(resultsDir, "vc-history.json"), JSON.stringify(report, null, 2) + "\n");
  const csv = ["prior_changes,n,verify_mean_ms,verify_ci95,verify_p50_ms,verify_p95_ms,verify_min,verify_max,median_relative_to_baseline"];
  for (const l of report.levels) {
    csv.push(
      `${l.priorChanges},${l.verify.n},${l.verify.mean},${l.verify.ci95},${l.verify.p50},${l.verify.p95},${l.verify.min},${l.verify.max},${l.medianRelativeToBaseline}`
    );
  }
  fs.writeFileSync(path.join(resultsDir, "vc-history.csv"), csv.join("\n") + "\n");
  console.log("\nWrote results/vc-history.json and results/vc-history.csv");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
