const crypto = require("crypto");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");
const { loadDeployment, getProvider, getActors } = require("./lib/network");
const { buildResolver } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");

// Demonstrates the "EHR Operation" Verifiable Credential described in the
// paper's Fig. `EHROperation`: a physician requests a lab exam for a
// patient, and the request itself is issued as a signed VC-JWT so any third
// party (the lab, an auditor) can verify who requested it and that it has
// not been tampered with, without needing to trust a central database.

function heading(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const resolver = buildResolver(deployment);

  const doctorDid = makeEthrDid(actors.doctor, deployment);
  const patientDid = makeEthrDid(actors.patient, deployment);

  heading("Issuing an EHR Operation VC (lab exam request)");
  const vcPayload = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ["VerifiableCredential", "EHROperationCredential"],
    issuer: { id: doctorDid.did },
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: patientDid.did,
      operation: "LabExamRequest",
      examType: "Complete Blood Count",
      requestedBy: doctorDid.did,
    },
  };
  const vcJwt = await createVerifiableCredentialJwt(vcPayload, doctorDid);
  console.log("Issued VC-JWT:");
  console.log(vcJwt);

  heading("Verifying the VC (happy path)");
  const verified = await verifyCredential(vcJwt, resolver);
  console.log("Verified. Issuer:", verified.issuer, " Subject:", verified.verifiableCredential.credentialSubject.id);

  heading("Negative case: tampered credential");
  const [headerB64, payloadB64, signatureB64] = vcJwt.split(".");
  const tamperedPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  tamperedPayload.vc.credentialSubject.examType = "HIV test"; // attacker changes the exam type
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
  const tamperedJwt = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;
  try {
    await verifyCredential(tamperedJwt, resolver);
    console.log("UNEXPECTED: tampered credential verified successfully (this would be a bug).");
  } catch (error) {
    console.log("Correctly rejected tampered credential:", error.message);
  }

  heading("Negative case: expired credential");
  const expiredPayload = {
    ...vcPayload,
    issuanceDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    expirationDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // expired yesterday
  };
  const expiredJwt = await createVerifiableCredentialJwt(expiredPayload, doctorDid);
  try {
    await verifyCredential(expiredJwt, resolver);
    console.log("UNEXPECTED: expired credential verified successfully (this would be a bug).");
  } catch (error) {
    console.log("Correctly rejected expired credential:", error.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
