const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Resolver } = require("did-resolver");
const { getResolver } = require("ethr-did-resolver");
const { EthrDID } = require("ethr-did");
const { createVerifiableCredentialJwt, verifyCredential } = require("did-jwt-vc");

// Same mnemonic Hardhat's own default accounts use; see scripts/lib/network.js
// for why this is safe to hardcode (local-testing-only, publicly documented).
const MNEMONIC = "test test test test test test test test test test test junk";

function deriveWallet(index, provider) {
  return ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

async function expectRejection(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    expect(error.message).to.match(pattern);
    return;
  }
  expect.fail("Expected promise to reject, but it resolved");
}

describe("Verifiable Credentials (EHR Operation)", function () {
  async function setup() {
    const provider = ethers.provider;
    const { chainId } = await provider.getNetwork();
    const EHRRegistry = await ethers.getContractFactory("EHRRegistry");
    const registry = await EHRRegistry.deploy();
    await registry.waitForDeployment();
    const registryAddress = await registry.getAddress();

    const doctorWallet = deriveWallet(1, provider);
    const patientWallet = deriveWallet(0, provider);

    const makeDid = (wallet) =>
      new EthrDID({
        identifier: wallet.address,
        privateKey: wallet.privateKey,
        provider,
        chainNameOrId: chainId,
        registry: registryAddress,
      });

    const doctorDid = makeDid(doctorWallet);
    const patientDid = makeDid(patientWallet);
    const resolver = new Resolver(
      getResolver({ networks: [{ name: "hardhat-test", chainId, provider, registry: registryAddress }] })
    );

    return { doctorDid, patientDid, resolver };
  }

  function credentialPayload(doctorDid, patientDid, overrides = {}) {
    return {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiableCredential", "EHROperationCredential"],
      issuer: { id: doctorDid.did },
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: patientDid.did,
        operation: "LabExamRequest",
        examType: "Complete Blood Count",
        requestedBy: doctorDid.did,
      },
      ...overrides,
    };
  }

  it("verifies a VC signed by the issuing physician's DID", async function () {
    const { doctorDid, patientDid, resolver } = await setup();
    const vcJwt = await createVerifiableCredentialJwt(credentialPayload(doctorDid, patientDid), doctorDid);
    const verified = await verifyCredential(vcJwt, resolver);
    expect(verified.issuer).to.equal(doctorDid.did);
    expect(verified.verifiableCredential.credentialSubject.id).to.equal(patientDid.did);
  });

  it("rejects a VC whose payload was tampered with after signing", async function () {
    const { doctorDid, patientDid, resolver } = await setup();
    const vcJwt = await createVerifiableCredentialJwt(credentialPayload(doctorDid, patientDid), doctorDid);
    const [headerB64, payloadB64, signatureB64] = vcJwt.split(".");
    const tamperedPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    tamperedPayload.vc.credentialSubject.examType = "HIV test";
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
    const tamperedJwt = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

    await expectRejection(verifyCredential(tamperedJwt, resolver), /invalid_signature/);
  });

  it("rejects a VC that has already expired", async function () {
    const { doctorDid, patientDid, resolver } = await setup();
    const payload = credentialPayload(doctorDid, patientDid, {
      issuanceDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      expirationDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const vcJwt = await createVerifiableCredentialJwt(payload, doctorDid);

    await expectRejection(verifyCredential(vcJwt, resolver), /expired/);
  });

  it("cannot be forged by putting the doctor's DID in the payload and signing with a different key", async function () {
    const { doctorDid, patientDid, resolver } = await setup();
    const impostorWallet = deriveWallet(5, ethers.provider);
    const impostorDid = new EthrDID({
      identifier: impostorWallet.address,
      privateKey: impostorWallet.privateKey,
      provider: ethers.provider,
      chainNameOrId: (await ethers.provider.getNetwork()).chainId,
    });
    // The payload *claims* issuer.id = doctorDid.did, but is actually signed
    // by the impostor's key. did-jwt-vc's `iss` claim always reflects who
    // really signed the JWT, so verification correctly attributes it to the
    // impostor rather than being spoofed into showing the doctor.
    const vcJwt = await createVerifiableCredentialJwt(credentialPayload(doctorDid, patientDid), impostorDid);
    const verified = await verifyCredential(vcJwt, resolver);

    expect(verified.issuer).to.equal(impostorDid.did);
    expect(verified.issuer).to.not.equal(doctorDid.did);
  });
});
