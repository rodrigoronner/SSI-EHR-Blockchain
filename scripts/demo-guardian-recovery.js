const { ethers } = require("ethers");
const artifact = require("../artifacts/contracts/EHRRegistry.sol/EHRRegistry.json");
const { loadDeployment, getProvider, getActors, deriveWallet, createNonceTracker } = require("./lib/network");
const { saveKeystore, loadKeystore } = require("./lib/keystore");

// Key management, end to end:
//   1) Storage: the patient's key is encrypted to a password-protected V3
//      keystore file (geth/MetaMask format), then decrypted back.
//   2) Recovery: simulates the keystore and password both being lost. The
//      pre-registered guardians jointly move the identity to a new address
//      without ever needing the old key.

function heading(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const actors = getActors(provider);
  const nextNonce = createNonceTracker(provider);
  const registry = new ethers.Contract(deployment.registryAddress, artifact.abi, provider);

  const patient = actors.patient;
  const guardianA = deriveWallet(10, provider);
  const guardianB = deriveWallet(11, provider);
  const guardianC = deriveWallet(12, provider);
  const funder = actors.doctor; // stands in for a clinic/faucet funding a new key on enrollment

  // -----------------------------------------------------------------
  // 1) Storage: encrypt the patient's key into a local keystore file
  // -----------------------------------------------------------------
  heading("1) Storing the patient's key as a password-encrypted keystore");
  const password = "correct horse battery staple"; // demo only — never hardcode a real passphrase
  const keystorePath = await saveKeystore(patient, password, "patient-demo.json");
  console.log("Encrypted keystore written to:", keystorePath);

  const recovered = await loadKeystore("patient-demo.json", password, provider);
  console.log(
    "Decrypted with the correct password -> address matches original key:",
    recovered.address === patient.address
  );

  // -----------------------------------------------------------------
  // 2) Pre-register guardians (done ahead of time, while the key is fine)
  // -----------------------------------------------------------------
  heading("2) Registering 3 guardians with a 2-of-3 recovery threshold");
  const guardianList = [guardianA.address, guardianB.address, guardianC.address];
  await (
    await registry
      .connect(patient)
      .setGuardians(patient.address, guardianList, 2, { nonce: await nextNonce(patient.address) })
  ).wait();
  console.log("Guardians:", guardianList);
  console.log("Threshold: 2 of 3");

  // -----------------------------------------------------------------
  // 3) Simulate real key loss: keystore file AND password both gone.
  // A brand-new key is generated for the patient to move to.
  // -----------------------------------------------------------------
  heading("3) Simulating total key loss — generating a fresh replacement key");
  const newPatientKey = ethers.Wallet.createRandom().connect(provider);
  console.log("New (as yet unauthorized) address:", newPatientKey.address);
  await (await funder.sendTransaction({ to: newPatientKey.address, value: ethers.parseEther("1") })).wait();

  heading("4) Guardians approve recovery to the new address");
  const tx1 = await registry
    .connect(guardianA)
    .approveRecovery(patient.address, newPatientKey.address, { nonce: await nextNonce(guardianA.address) });
  await tx1.wait();
  console.log(`${guardianA.address} approved (1/2)`);
  console.log(
    "Identity owner still the lost key?",
    (await registry.identityOwner(patient.address)) === patient.address
  );

  const tx2 = await registry
    .connect(guardianB)
    .approveRecovery(patient.address, newPatientKey.address, { nonce: await nextNonce(guardianB.address) });
  const receipt2 = await tx2.wait();
  console.log(`${guardianB.address} approved (2/2) -> threshold reached`);
  const executed = receipt2.logs.some((log) => {
    try {
      return registry.interface.parseLog(log)?.name === "RecoveryExecuted";
    } catch {
      return false;
    }
  });
  console.log("RecoveryExecuted event emitted:", executed);

  const newOwner = await registry.identityOwner(patient.address);
  console.log("Identity owner is now the new key:", newOwner === newPatientKey.address);

  heading("5) Old key can no longer act; new key has full control");
  try {
    await registry
      .connect(patient)
      .setGuardians(patient.address, [guardianC.address], 1, { nonce: await nextNonce(patient.address) });
    console.log("UNEXPECTED: the old, supposedly-lost key could still act (this would be a bug).");
  } catch (error) {
    console.log("Old key correctly rejected:", error.shortMessage || error.message);
  }

  await (
    await registry
      .connect(newPatientKey)
      .setGuardians(patient.address, [guardianC.address], 1, { nonce: await nextNonce(newPatientKey.address) })
  ).wait();
  console.log("New key successfully re-established its own guardian set (1-of-1, guardianC), confirming full control.");

  heading("6) New key's turn to be stored safely");
  const newKeystorePath = await saveKeystore(newPatientKey, password, "patient-demo-recovered.json");
  console.log("New key encrypted to keystore:", newKeystorePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
