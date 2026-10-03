const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DELEGATE_TYPE = ethers.encodeBytes32String("responsible-party");
const ATTR_SERVICE = ethers.encodeBytes32String("did/svc/Scheduling");

describe("EHRRegistry", function () {
  async function deployFixture() {
    const [patient, doctor, hospitalBuyer, delegate, stranger] = await ethers.getSigners();
    const EHRRegistry = await ethers.getContractFactory("EHRRegistry");
    const registry = await EHRRegistry.deploy();
    await registry.waitForDeployment();
    return { registry, patient, doctor, hospitalBuyer, delegate, stranger };
  }

  it("defaults identityOwner to the identity's own address (implicit did:ethr)", async function () {
    const { registry, patient } = await loadFixture(deployFixture);
    expect(await registry.identityOwner(patient.address)).to.equal(patient.address);
  });

  describe("changeOwner (hospital acquisition use case)", function () {
    it("lets the current owner transfer ownership", async function () {
      const { registry, patient, hospitalBuyer } = await loadFixture(deployFixture);
      await expect(registry.connect(patient).changeOwner(patient.address, hospitalBuyer.address))
        .to.emit(registry, "DIDOwnerChanged")
        .withArgs(patient.address, hospitalBuyer.address, 0n);
      expect(await registry.identityOwner(patient.address)).to.equal(hospitalBuyer.address);
    });

    it("reverts when called by a non-owner [adversarial]", async function () {
      const { registry, patient, stranger } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).changeOwner(patient.address, stranger.address)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    });

    it("refuses to transfer ownership to the zero address, which would hand control back to the original key [adversarial]", async function () {
      const { registry, patient, hospitalBuyer } = await loadFixture(deployFixture);
      await registry.connect(patient).changeOwner(patient.address, hospitalBuyer.address);
      await expect(
        registry.connect(hospitalBuyer).changeOwner(patient.address, ethers.ZeroAddress)
      ).to.be.revertedWith("EHRRegistry: new owner cannot be the zero address");
      expect(await registry.identityOwner(patient.address)).to.equal(hospitalBuyer.address);
    });

    it("keeps the previous owner's delegates valid after a transfer, until the new owner revokes them", async function () {
      const { registry, patient, hospitalBuyer, stranger } = await loadFixture(deployFixture);
      const sigAuth = ethers.encodeBytes32String("sigAuth");
      await registry.connect(patient).addDelegate(patient.address, sigAuth, stranger.address, 3600);
      await registry.connect(patient).changeOwner(patient.address, hospitalBuyer.address);
      // Delegates belong to the identity, not to its owner, so the transfer
      // alone does not remove them: a new owner (e.g. a hospital's acquirer)
      // has to revoke the previous owner's delegates explicitly.
      expect(await registry.validDelegate(patient.address, sigAuth, stranger.address)).to.equal(true);
      await registry.connect(hospitalBuyer).revokeDelegate(patient.address, sigAuth, stranger.address);
      expect(await registry.validDelegate(patient.address, sigAuth, stranger.address)).to.equal(false);
    });

    it("the identifier itself never changes across ownership transfer", async function () {
      const { registry, patient, hospitalBuyer } = await loadFixture(deployFixture);
      const identityBefore = patient.address;
      await registry.connect(patient).changeOwner(patient.address, hospitalBuyer.address);
      // did:ethr:<chainId>:<identity address> — identity address is immutable,
      // only the resolved owner/controller changes.
      expect(identityBefore).to.equal(patient.address);
    });
  });

  describe("addDelegate / revokeDelegate (temporary delegation use case)", function () {
    it("marks a delegate valid until the requested validity period elapses", async function () {
      const { registry, patient, delegate } = await loadFixture(deployFixture);
      const oneDay = 24 * 60 * 60;
      await expect(registry.connect(patient).addDelegate(patient.address, DELEGATE_TYPE, delegate.address, oneDay))
        .to.emit(registry, "DIDDelegateChanged");
      expect(await registry.validDelegate(patient.address, DELEGATE_TYPE, delegate.address)).to.equal(true);
    });

    it("an unrelated address is never a valid delegate", async function () {
      const { registry, patient, stranger } = await loadFixture(deployFixture);
      expect(await registry.validDelegate(patient.address, DELEGATE_TYPE, stranger.address)).to.equal(false);
    });

    it("revoking a delegate immediately invalidates it (access revocation use case)", async function () {
      const { registry, patient, delegate } = await loadFixture(deployFixture);
      const oneDay = 24 * 60 * 60;
      await registry.connect(patient).addDelegate(patient.address, DELEGATE_TYPE, delegate.address, oneDay);
      await registry.connect(patient).revokeDelegate(patient.address, DELEGATE_TYPE, delegate.address);
      expect(await registry.validDelegate(patient.address, DELEGATE_TYPE, delegate.address)).to.equal(false);
    });

    it("reverts when a non-owner tries to add or revoke a delegate [adversarial]", async function () {
      const { registry, patient, delegate, stranger } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).addDelegate(patient.address, DELEGATE_TYPE, delegate.address, 3600)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    });
  });

  describe("setAttribute / revokeAttribute (service endpoints & IPFS document hashes)", function () {
    it("emits DIDAttributeChanged with the published value", async function () {
      const { registry, patient } = await loadFixture(deployFixture);
      const value = ethers.toUtf8Bytes("https://hospital.example/scheduling-api");
      await expect(registry.connect(patient).setAttribute(patient.address, ATTR_SERVICE, value, 0))
        .to.emit(registry, "DIDAttributeChanged");
    });

    it("revokeAttribute emits validTo = 0 (verifiable revocation use case)", async function () {
      const { registry, patient } = await loadFixture(deployFixture);
      const value = ethers.toUtf8Bytes("https://hospital.example/scheduling-api");
      await registry.connect(patient).setAttribute(patient.address, ATTR_SERVICE, value, 3600);
      await expect(registry.connect(patient).revokeAttribute(patient.address, ATTR_SERVICE, value))
        .to.emit(registry, "DIDAttributeChanged")
        .withArgs(patient.address, ATTR_SERVICE, ethers.hexlify(value), 0n, anyValue);
    });

    it("reverts when a non-owner tries to publish an attribute [adversarial]", async function () {
      const { registry, patient, stranger } = await loadFixture(deployFixture);
      const value = ethers.toUtf8Bytes("https://malicious.example");
      await expect(
        registry.connect(stranger).setAttribute(patient.address, ATTR_SERVICE, value, 0)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    });
  });
});
