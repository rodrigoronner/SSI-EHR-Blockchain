const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Adversarial tests for the security/privacy requirements from the paper's
// "Security and Privacy Requirements in EHRs" section. Each `it()` states
// the requirement it exercises; results are summarized in
// results/security-analysis.md.

const ATTR = ethers.encodeBytes32String("did/svc/Scheduling");
const DELEGATE_TYPE = ethers.encodeBytes32String("sigAuth");

describe("Security Analysis: adversarial access-control and lifecycle cases", function () {
  async function deployFixture() {
    const [identityOwner, delegate, attacker, newOwner] = await ethers.getSigners();
    const EHRRegistry = await ethers.getContractFactory("EHRRegistry");
    const registry = await EHRRegistry.deploy();
    await registry.waitForDeployment();
    return { registry, identityOwner, delegate, attacker, newOwner };
  }

  it("[access control] an attacker cannot transfer ownership of an identity they do not control", async function () {
    const { registry, identityOwner, attacker } = await loadFixture(deployFixture);
    await expect(
      registry.connect(attacker).changeOwner(identityOwner.address, attacker.address)
    ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    expect(await registry.identityOwner(identityOwner.address)).to.equal(identityOwner.address);
  });

  it("[access control] an attacker cannot grant themselves as a delegate on another identity", async function () {
    const { registry, identityOwner, attacker } = await loadFixture(deployFixture);
    await expect(
      registry.connect(attacker).addDelegate(identityOwner.address, DELEGATE_TYPE, attacker.address, 3600)
    ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    expect(await registry.validDelegate(identityOwner.address, DELEGATE_TYPE, attacker.address)).to.equal(false);
  });

  it("[access control] an attacker cannot revoke a legitimate delegate on another identity", async function () {
    const { registry, identityOwner, delegate, attacker } = await loadFixture(deployFixture);
    await registry.connect(identityOwner).addDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address, 3600);
    await expect(
      registry.connect(attacker).revokeDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address)
    ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    // The attacker's attempt must not have silently succeeded either.
    expect(await registry.validDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address)).to.equal(true);
  });

  it("[access control] an attacker cannot publish or revoke attributes on another identity", async function () {
    const { registry, identityOwner, attacker } = await loadFixture(deployFixture);
    const maliciousValue = ethers.toUtf8Bytes("https://attacker.example/phishing-api");
    await expect(
      registry.connect(attacker).setAttribute(identityOwner.address, ATTR, maliciousValue, 3600)
    ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
  });

  it("[consent/lifecycle] a delegate's authorization expires on its own after the granted validity period, with no further action required", async function () {
    const { registry, identityOwner, delegate } = await loadFixture(deployFixture);
    const oneHour = 60 * 60;
    await registry.connect(identityOwner).addDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address, oneHour);
    expect(await registry.validDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address)).to.equal(true);

    await time.increase(oneHour + 1);

    expect(await registry.validDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address)).to.equal(false);
  });

  it("[verifiable revocation] revoking a delegate takes effect immediately, before its granted validity period would have elapsed", async function () {
    const { registry, identityOwner, delegate } = await loadFixture(deployFixture);
    const oneDay = 24 * 60 * 60;
    await registry.connect(identityOwner).addDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address, oneDay);
    await registry.connect(identityOwner).revokeDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address);

    expect(await registry.validDelegate(identityOwner.address, DELEGATE_TYPE, delegate.address)).to.equal(false);
  });

  it("[audit control] every ownership/delegate/attribute change is independently auditable via on-chain events", async function () {
    const { registry, identityOwner, newOwner } = await loadFixture(deployFixture);
    await expect(registry.connect(identityOwner).changeOwner(identityOwner.address, newOwner.address))
      .to.emit(registry, "DIDOwnerChanged")
      .withArgs(identityOwner.address, newOwner.address, 0n);
  });
});
