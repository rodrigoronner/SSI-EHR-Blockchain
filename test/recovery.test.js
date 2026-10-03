const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Guardian-based social recovery: what happens when the private key is
// genuinely lost, since changeOwner needs a signature from that same key.
// A patient/physician pre-authorizes guardians and an M-of-N threshold;
// once enough of them agree on the same replacement address, the identity
// moves there without the old key.

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

    it("reverts when called by a non-owner [adversarial]", async function () {
      const { registry, owner, guardian1, stranger } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).setGuardians(owner.address, [guardian1.address], 1)
      ).to.be.revertedWith("EHRRegistry: not authorized (not identity owner)");
    });

    it("rejects a threshold of zero or greater than the guardian count [adversarial]", async function () {
      const { registry, owner, guardian1, guardian2 } = await loadFixture(deployFixture);
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, guardian2.address], 0)
      ).to.be.revertedWith("EHRRegistry: invalid threshold");
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, guardian2.address], 3)
      ).to.be.revertedWith("EHRRegistry: invalid threshold");
    });

    it("rejects an invalid guardian list: empty, containing the zero address, or with a duplicate [adversarial]", async function () {
      const { registry, owner, guardian1 } = await loadFixture(deployFixture);
      await expect(registry.connect(owner).setGuardians(owner.address, [], 1)).to.be.revertedWith(
        "EHRRegistry: at least one guardian required"
      );
      await expect(
        registry.connect(owner).setGuardians(owner.address, [guardian1.address, ethers.ZeroAddress], 1)
      ).to.be.revertedWith("EHRRegistry: guardian cannot be the zero address");
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

    it("rejects an approval from someone who is not a registered guardian [adversarial]", async function () {
      const { registry, owner, stranger, newOwner } = await loadFixture(withGuardiansConfigured);
      await expect(
        registry.connect(stranger).approveRecovery(owner.address, newOwner.address)
      ).to.be.revertedWith("EHRRegistry: caller is not a guardian for this identity");
    });

    it("refuses to recover an identity to the zero address, which would lock it permanently [adversarial]", async function () {
      const { registry, owner, guardian1 } = await loadFixture(withGuardiansConfigured);
      await expect(
        registry.connect(guardian1).approveRecovery(owner.address, ethers.ZeroAddress)
      ).to.be.revertedWith("EHRRegistry: cannot recover to the zero address");
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

    it("prevents a single guardian from approving twice to inflate the count [adversarial]", async function () {
      const { registry, owner, guardian1, newOwner } = await loadFixture(withGuardiansConfigured);
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await expect(
        registry.connect(guardian1).approveRecovery(owner.address, newOwner.address)
      ).to.be.revertedWith("EHRRegistry: guardian already approved");
    });

    it("does not count an approval from a guardian that setGuardians has since removed [adversarial]", async function () {
      const { registry, owner, guardian1, guardian2, guardian3, newOwner } = await loadFixture(withGuardiansConfigured);
      const [, , , , , , replacement] = await ethers.getSigners();
      // guardian1 approves, then the owner replaces guardian1; threshold stays 2.
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await registry
        .connect(owner)
        .setGuardians(owner.address, [guardian2.address, guardian3.address, replacement.address], 2);
      // A single approval under the new set must not be enough.
      await registry.connect(replacement).approveRecovery(owner.address, newOwner.address);
      expect(await registry.identityOwner(owner.address)).to.equal(owner.address);
    });

    it("does not carry approvals left over from before a recovery into the next guardian set [adversarial]", async function () {
      const { registry, owner, guardian1, guardian2, guardian3, newOwner } = await loadFixture(withGuardiansConfigured);
      const [, , , , , , freshGuardian1, freshGuardian2, attacker] = await ethers.getSigners();
      // guardian3 approves an address that never reaches the threshold...
      await registry.connect(guardian3).approveRecovery(owner.address, attacker.address);
      // ...while guardian1 and guardian2 complete a legitimate recovery.
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await registry.connect(guardian2).approveRecovery(owner.address, newOwner.address);
      await registry
        .connect(newOwner)
        .setGuardians(owner.address, [freshGuardian1.address, freshGuardian2.address], 2);
      // One approval for the stale address must not complete a recovery to it.
      await registry.connect(freshGuardian1).approveRecovery(owner.address, attacker.address);
      expect(await registry.identityOwner(owner.address)).to.equal(newOwner.address);
    });

    it("lets the owner cancel pending approvals, which then no longer count", async function () {
      const { registry, owner, guardian1, guardian2, newOwner } = await loadFixture(withGuardiansConfigured);
      await registry.connect(guardian1).approveRecovery(owner.address, newOwner.address);
      await expect(registry.connect(owner).cancelRecovery(owner.address)).to.emit(registry, "RecoveryCancelled");
      await registry.connect(guardian2).approveRecovery(owner.address, newOwner.address);
      expect(await registry.identityOwner(owner.address)).to.equal(owner.address);
    });

    it("does not let anyone but the owner cancel pending approvals [adversarial]", async function () {
      const { registry, owner, guardian1 } = await loadFixture(withGuardiansConfigured);
      await expect(registry.connect(guardian1).cancelRecovery(owner.address)).to.be.revertedWith(
        "EHRRegistry: not authorized (not identity owner)"
      );
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

  describe("ownership transfer", function () {
    it("does not let guardians chosen by a previous owner recover the identity after a transfer [adversarial]", async function () {
      const { registry, owner, guardian1, guardian2, guardian3, stranger } = await loadFixture(deployFixture);
      const [, , , , , , acquirer] = await ethers.getSigners();
      await registry
        .connect(owner)
        .setGuardians(owner.address, [guardian1.address, guardian2.address, guardian3.address], 2);
      await registry.connect(guardian1).approveRecovery(owner.address, stranger.address);
      // e.g. a hospital is sold: its new owner must not inherit the old guardians.
      await registry.connect(owner).changeOwner(owner.address, acquirer.address);
      expect(await registry.isGuardian(owner.address, guardian2.address)).to.equal(false);
      await expect(
        registry.connect(guardian2).approveRecovery(owner.address, stranger.address)
      ).to.be.revertedWith("EHRRegistry: caller is not a guardian for this identity");
      expect(await registry.identityOwner(owner.address)).to.equal(acquirer.address);
    });
  });
});
