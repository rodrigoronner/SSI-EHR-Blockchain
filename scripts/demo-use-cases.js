const { DelegateTypes } = require("ethr-did");
const { loadDeployment, getProvider, getActors, createNonceTracker } = require("./lib/network");
const { buildEthrResolver, resolveAsOfChainHead } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");

// End-to-end walkthrough of the four use cases the paper enumerates in the
// Introduction, plus DID ownership transfer, all executed against a real
// (local) Ethereum network via the deployed EHRRegistry contract.
//
// Usage:
//   1) npm run node            (terminal 1, keep running)
//   2) npm run deploy          (terminal 2)
//   3) npm run demo            (terminal 2)

function heading(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const nextNonce = createNonceTracker(provider);
  // A fresh EthrDidResolver per call avoids stale reads from whatever
  // internal caching its underlying ethers Contract/Provider does when the
  // same instance is reused across several sequential resolutions.
  const resolve = (did) => resolveAsOfChainHead(buildEthrResolver(deployment), did, provider);

  const patientDid = makeEthrDid(actors.patient, deployment);
  const hospitalDid = makeEthrDid(actors.hospital, deployment);

  heading("Actor DIDs (implicit from Ethereum address, did:ethr method)");
  console.log("Patient  :", patientDid.did);
  console.log("Doctor   :", makeEthrDid(actors.doctor, deployment).did);
  console.log("Hospital :", hospitalDid.did);
  console.log("Investor :", actors.investor.address);
  console.log("Guardian :", actors.guardianDelegate.address);

  // -----------------------------------------------------------------
  // Use case iv) delegating one's identity to a third party
  // (e.g. a parent temporarily delegating a minor's identity to a
  // responsible adult while the minor is under care)
  // -----------------------------------------------------------------
  heading("Use case iv) Delegating identity to a third party");
  const delegateExpirySeconds = 60 * 60; // 1 hour, for demo purposes
  await patientDid.addDelegate(
    actors.guardianDelegate.address,
    { delegateType: DelegateTypes.sigAuth, expiresIn: delegateExpirySeconds },
    { nonce: await nextNonce(actors.patient.address) }
  );
  console.log(
    `Guardian ${actors.guardianDelegate.address} authorized as sigAuth delegate for ${delegateExpirySeconds}s`
  );

  let doc = await resolve(patientDid.did);
  console.log(
    "Patient DID Document authentication entries:",
    doc.didDocument.authentication?.length ?? 0
  );

  // -----------------------------------------------------------------
  // Use case ii) data access revocation
  // -----------------------------------------------------------------
  heading("Use case ii) Data access revocation");
  await patientDid.revokeDelegate(actors.guardianDelegate.address, DelegateTypes.sigAuth, {
    nonce: await nextNonce(actors.patient.address),
  });
  doc = await resolve(patientDid.did);
  console.log(
    "Patient DID Document authentication entries after revocation:",
    doc.didDocument.authentication?.length ?? 0
  );

  // -----------------------------------------------------------------
  // Use case iii) verifiable data revocation
  // (publish an attribute referencing an EHR document, then revoke it
  // verifiably — anyone resolving the DID can confirm it was revoked)
  // -----------------------------------------------------------------
  heading("Use case iii) Verifiable data revocation");
  const recordHash = "0x" + "11".repeat(32); // placeholder for a real IPFS-content hash
  await patientDid.setAttribute(
    "ehr/doc/exam-2026-07-28",
    recordHash,
    24 * 60 * 60,
    undefined,
    { nonce: await nextNonce(actors.patient.address) }
  );
  console.log("Published attribute referencing an EHR document hash on-chain.");
  await patientDid.revokeAttribute("ehr/doc/exam-2026-07-28", recordHash, undefined, {
    nonce: await nextNonce(actors.patient.address),
  });
  console.log("Revoked it. Revocation is itself an on-chain, auditable event (DIDAttributeChanged, validTo=0).");

  // Hospital service endpoint (Fig. "DID Attribute transaction" in the paper)
  await hospitalDid.setAttribute(
    "did/svc/Scheduling",
    "https://hospital.example/scheduling-api",
    24 * 60 * 60,
    undefined,
    { nonce: await nextNonce(actors.hospital.address) }
  );
  console.log("Hospital published a scheduling service endpoint attribute.");

  // -----------------------------------------------------------------
  // Ownership transfer (hospital acquired by an investor)
  // -----------------------------------------------------------------
  heading("Ownership transfer (hospital acquisition use case)");
  console.log("Hospital identifier before transfer:", hospitalDid.address);
  await hospitalDid.changeOwner(actors.investor.address, {
    nonce: await nextNonce(actors.hospital.address),
  });
  const newOwner = await hospitalDid.lookupOwner();
  console.log("Hospital identifier after transfer :", hospitalDid.address, "(unchanged)");
  console.log("New controller/owner               :", newOwner);

  // -----------------------------------------------------------------
  // Use case i) patient data recovery
  // (full DID Document resolution: everything needed to reconstruct
  // the identity's current state is recoverable from chain data alone)
  // -----------------------------------------------------------------
  heading("Use case i) Patient data recovery (full DID Document resolution)");
  const finalPatientDoc = await resolve(patientDid.did);
  console.log(JSON.stringify(finalPatientDoc.didDocument, null, 2));

  heading("Hospital DID Document (post-acquisition, with service endpoint)");
  const finalHospitalDoc = await resolve(hospitalDid.did);
  console.log(JSON.stringify(finalHospitalDoc.didDocument, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
