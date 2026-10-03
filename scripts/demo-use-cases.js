const { DelegateTypes } = require("ethr-did");
const { loadDeployment, getProvider, getActors, createNonceTracker } = require("./lib/network");
const { buildEthrResolver, resolveAsOfChainHead } = require("./lib/resolver");
const { makeEthrDid } = require("./lib/did");
const { encrypt } = require("./lib/aesgcm");

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
  // Fresh resolver per call to avoid stale reads across sequential resolutions.
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
  // The anchor is the CID of an encrypted (synthetic) document: the same CID
  // IPFS would assign to it, computed here without running a node. The full
  // store-and-retrieve path is in scripts/ipfs-store.js (`npm run ipfs-demo`).
  const { CID } = await import("multiformats/cid");
  const { sha256 } = await import("multiformats/hashes/sha2");
  const raw = await import("multiformats/codecs/raw");
  const crypto = require("crypto");
  const document = Buffer.from(JSON.stringify({ result: "Within normal reference ranges." }));
  const ciphertext = encrypt(document, crypto.randomBytes(32));
  const recordCid = CID.create(1, raw.code, await sha256.digest(ciphertext)).toString();
  const recordHash = recordCid;
  // An opaque name: attribute names are public, so they must not say what
  // kind of record they point to.
  const recordName = "doc/" + crypto.randomBytes(8).toString("hex");
  await patientDid.setAttribute(
    recordName,
    recordHash,
    24 * 60 * 60,
    undefined,
    { nonce: await nextNonce(actors.patient.address) }
  );
  console.log(`Published attribute ${recordName} anchoring the document's CID ${recordCid} on-chain.`);
  await patientDid.revokeAttribute(recordName, recordHash, undefined, {
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
  // the identity's current state is recoverable from chain data alone;
  // the records anchored to it are recovered from IPFS by another
  // physician in scripts/ipfs-store.js, `npm run ipfs-demo`)
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
