const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Guardian-based social recovery: answers "what if the private key is lost"
// (as opposed to `changeOwner`, which requires a signature from the very key
// that's assumed lost). A patient/physician pre-authorizes a set of
// guardians and an M-of-N threshold; once enough guardians agree on the same
// replacement address, the identity moves there without the old key.

describe("Guardian-based social recovery", function () {
  async function deployFixture() {
    const [owner, guardian1, guardian2, guardian3, newOwner, stranger] = await ethers.getSigners();
    const EHRRegistry = await ethers.getContractFactory("EHRRegistry");
    const registry = await EHRRegistry.deploy();
    await registry.waitForDeployment();
    return { registry, owner, guardian1, guardian2, guardian3, newOwner, stranger };
  }

  describe("setGuardians", function () {
    it("lets the owner configure a guardian set and threshold", async function () {
      const { registry, owner, guardian1, guardian2, guardian3 } = await loadFixture(deployFixture);
      const guardianList = [guardian1.address, guardian2.address, guardian3.address];
      await expect(registry.connect(owner).setGuardians(owner.address, guardianList, 2))
        .to.emit(registry, "GuardiansConfigured")
        .withArgs(owner.address, guardianList, 2n);
      expect(await registry.isGuardian(owner.address, guardian1.address)).to.equal(true);
      expect(await registry.isGuardian(owner.address, guardian2.address)).to.equal(true);
    });

    it("reverts when called by a non-owner", async function () {
      const { registry, owner, guardian1, stranger } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).setGuardians(owner.address, [guardian1.address], 1)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    });

    it("rejects a threshold of zero or greater than the guardian count", async function () {
      const { registry, owner, guardian1, guardian2 } = await loadFixture(deployFixture);
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, guardian2.address], 0)
      ).to.be.revertedWith("EHRRegistry: invalid threshold");
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, guardian2.address], 3)
      ).to.be.revertedWith("EHRRegistry: invalid threshold");
    });

    it("rejects a duplicate guardian in the same list", async function () {
      const { registry, owner, guardian1 } = await loadFixture(deployFixture);
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, guardian1.address], 1)
      ).to.be.revertedWith("EHRRegistry: duplicate guardian");
    });
  });

  describe("approveRecovery", function () {
    async function withGuardiansConfigured() {
      const fixture = await deployFixture();
      const { registry, owner, guardian1, guardian2, guardian3 } = fixture;
      await registry
        .connect(owner)
        .setGuardians(owner.address, [guardian1.address, guardian2.address, guardian3.address], 2);
      return fixture;
    }

    it("rejects an approval from someone who is not a registered guardian", async function () {
      const { registry, owner, stranger, newOwner } = await loadFixture(withGuardiansConfigured);
      await expect(
        registry.connect(stranger).approveRecovery(owner.address, newOwner.address)
      ).to.be.revertedWith("EHRRegistry: caller is not a guardian for this identity");
    });

    it("does not execute recovery before the approval threshold is met", async function () {
      const { registry, owner, guardian1, newOwner } = await loadFixture(withGuardiansConfigured);
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      // Only 1 of the required 2 approvals so far.
      expect(await registry.identityOwner(owner.address)).to.equal(owner.address);
    });

    it("executes recovery once the M-of-N threshold is reached, moving ownership to the agreed address", async function () {
      const { registry, owner, guardian1, guardian2, newOwner } = await loadFixture(withGuardiansConfigured);
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await expect(registry.connect(guardian2).approveRecovery(owner.address, newOwner.address))
        .to.emit(registry, "RecoveryExecuted")
        .withArgs(owner.address, newOwner.address);

      expect(await registry.identityOwner(owner.address)).to.equal(newOwner.address);
    });

    it("the identifier itself never changes across a guardian-driven recovery", async function () {
      const { registry, owner, guardian1, guardian2, newOwner } = await loadFixture(withGuardiansConfigured);
      const identityBefore = owner.address;
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await registry.connect(guardian2).approveRecovery(owner.address, newOwner.address);
      expect(identityBefore).to.equal(owner.address);
    });

    it("prevents a single guardian from approving twice to inflate the count", async function () {
      const { registry, owner, guardian1, newOwner } = await loadFixture(withGuardiansConfigured);
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await expect(
        registry.connect(guardian1).approveRecovery(owner.address, newOwner.address)
      ).to.be.revertedWith("EHRRegistry: guardian already approved");
    });

    it("clears the guardian set after a successful recovery, requiring the new owner to re-authorize guardians", async function () {
      const { registry, owner, guardian1, guardian2, guardian3, newOwner } = await loadFixture(
        withGuardiansConfigured
      );
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await registry.connect(guardian2).approveRecovery(owner.address, newOwner.address);

      expect(await registry.isGuardian(owner.address, guardian1.address)).to.equal(false);
      // A guardian from the old (now-cleared) set can no longer approve further recoveries.
      await expect(
        registry.connect(guardian3).approveRecovery(owner.address, newOwner.address)
      ).to.be.revertedWith("EHRRegistry: caller is not a guardian for this identity");
    });

    it("lets the new owner regain full self-sovereign control, including setting a fresh guardian set", async function () {
      const { registry, owner, guardian1, guardian2, guardian3, newOwner } = await loadFixture(
        withGuardiansConfigured
      );
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await registry.connect(guardian2).approveRecovery(owner.address, newOwner.address);

      // Old owner can no longer act on the identity post-recovery.
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian3.address], 1)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");

      // New owner can, including re-establishing guardians.
      await expect(registry.connect(newOwner).setGuardians(owner.address, [guardian3.address], 1)).to.emit(
        registry,
        "GuardiansConfigured"
      );
    });
  });
});
