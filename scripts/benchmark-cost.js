const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { DelegateTypes } = require("ethr-did");
const artifact = require("../artifacts/contracts/EHRRegistry.sol/EHRRegistry.json");
const { loadDeployment, getProvider, deriveWallet, createNonceTracker } = require("./lib/network");
const { makeEthrDid } = require("./lib/did");

// Cost Evaluation (paper Section "Results and Discussion"). Measures REAL
// gas usage (from transaction receipts on a local Hardhat network) for each
// EHRRegistry operation, then converts to ETH/USD using explicit, documented
// assumptions rather than a live price feed — these are knobs, not a claim
// about current market prices.
const GAS_PRICE_GWEI = 20; // representative of a quiet period on Ethereum mainnet
const ETH_USD_PRICE = 3000; // documented assumption, adjust as needed

// Hardhat's default local node only pre-funds accounts at derivation
// indices 0-19; each "identity" below is its own transaction sender
// (self-sovereign — identities pay their own gas), so we're capped at 20
// distinct, funded identities per run without manual funding.
const NUM_IDENTITIES = 5;
const IDENTITY_START_INDEX = 6; // avoid actors used by other demo scripts (0-5)
const RECOVERY_IDENTITY_START_INDEX = 11; // separate pool so recovery doesn't disturb changeOwner's identities (6-10)

function summarize(samples) {
  const values = samples.map((s) => s.gasUsed);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    minGas: Math.min(...values),
    meanGas: Math.round(mean),
    maxGas: Math.max(...values),
  };
}

function gasToCost(gas) {
  const eth = (gas * GAS_PRICE_GWEI) / 1e9;
  return { eth, usd: eth * ETH_USD_PRICE };
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const nextNonce = createNonceTracker(provider);
  const registryContract = new ethers.Contract(deployment.registryAddress, artifact.abi, provider);

  const results = {
    addDelegate: [],
    revokeDelegate: [],
    setAttributeShort: [],
    setAttributeCidLength: [],
    revokeAttribute: [],
    changeOwner: [],
    setGuardians: [],
    approveRecoveryNonExecuting: [],
    approveRecoveryExecuting: [],
  };

  for (let i = 0; i < NUM_IDENTITIES; i++) {
    const identityWallet = deriveWallet(IDENTITY_START_INDEX + i, provider);
    const identityDid = makeEthrDid(identityWallet, deployment);
    const delegateTarget = deriveWallet(0, provider).address; // any funded address works as the delegate/target
    const investorTarget = ethers.Wallet.createRandom().address; // gas cost doesn't depend on the target having funds

    const addReceiptHash = await identityDid.addDelegate(
      delegateTarget,
      { delegateType: DelegateTypes.sigAuth, expiresIn: 3600 },
      { nonce: await nextNonce(identityWallet.address) }
    );
    results.addDelegate.push({ label: "addDelegate", gasUsed: await gasUsedFor(provider, addReceiptHash) });

    const revokeDelegateHash = await identityDid.revokeDelegate(delegateTarget, DelegateTypes.sigAuth, {
      nonce: await nextNonce(identityWallet.address),
    });
    results.revokeDelegate.push({ label: "revokeDelegate", gasUsed: await gasUsedFor(provider, revokeDelegateHash) });

    const shortValue = "https://hospital.example/scheduling-api"; // ~41 bytes, service-endpoint-sized
    const setShortHash = await identityDid.setAttribute("did/svc/Scheduling", shortValue, 3600, undefined, {
      nonce: await nextNonce(identityWallet.address),
    });
    results.setAttributeShort.push({ label: "setAttribute (~41B, URL)", gasUsed: await gasUsedFor(provider, setShortHash) });

    const cidValue = "bafkreiejjxfnls5o4uqwtpt7xuluskifl2uas2vhwcloc7natfkkmi2y54"; // ~59 bytes, IPFS-CID-sized
    const setCidHash = await identityDid.setAttribute(`ehr/doc/exam-${i}`, cidValue, 3600, undefined, {
      nonce: await nextNonce(identityWallet.address),
    });
    results.setAttributeCidLength.push({
      label: "setAttribute (~59B, IPFS CID)",
      gasUsed: await gasUsedFor(provider, setCidHash),
    });

    const revokeAttrHash = await identityDid.revokeAttribute(`ehr/doc/exam-${i}`, cidValue, undefined, {
      nonce: await nextNonce(identityWallet.address),
    });
    results.revokeAttribute.push({ label: "revokeAttribute", gasUsed: await gasUsedFor(provider, revokeAttrHash) });

    const changeOwnerHash = await identityDid.changeOwner(investorTarget, {
      nonce: await nextNonce(identityWallet.address),
    });
    results.changeOwner.push({ label: "changeOwner", gasUsed: await gasUsedFor(provider, changeOwnerHash) });

    // Guardian recovery uses its own, separate identity per trial (indices
    // RECOVERY_IDENTITY_START_INDEX..+NUM_IDENTITIES) so that executing a
    // recovery here does not interfere with the changeOwner measurement above.
    const recoveryIdentity = deriveWallet(RECOVERY_IDENTITY_START_INDEX + i, provider);
    const guardians = [deriveWallet(16, provider), deriveWallet(17, provider), deriveWallet(18, provider)];
    const setGuardiansTx = await registryContract
      .connect(recoveryIdentity)
      .setGuardians(recoveryIdentity.address, guardians.map((g) => g.address), 2, {
        nonce: await nextNonce(recoveryIdentity.address),
      });
    const setGuardiansReceipt = await setGuardiansTx.wait();
    results.setGuardians.push({ label: "setGuardians", gasUsed: Number(setGuardiansReceipt.gasUsed) });

    const recoveryTarget = ethers.Wallet.createRandom().address;
    const firstApprovalTx = await registryContract
      .connect(guardians[0])
      .approveRecovery(recoveryIdentity.address, recoveryTarget, { nonce: await nextNonce(guardians[0].address) });
    const firstApprovalReceipt = await firstApprovalTx.wait();
    results.approveRecoveryNonExecuting.push({
      label: "approveRecovery (below threshold)",
      gasUsed: Number(firstApprovalReceipt.gasUsed),
    });

    const secondApprovalTx = await registryContract
      .connect(guardians[1])
      .approveRecovery(recoveryIdentity.address, recoveryTarget, { nonce: await nextNonce(guardians[1].address) });
    const secondApprovalReceipt = await secondApprovalTx.wait();
    results.approveRecoveryExecuting.push({
      label: "approveRecovery (threshold met, executes recovery)",
      gasUsed: Number(secondApprovalReceipt.gasUsed),
    });
  }

  const report = {
    assumptions: { gasPriceGwei: GAS_PRICE_GWEI, ethUsdPrice: ETH_USD_PRICE, trialsPerOperation: NUM_IDENTITIES },
    network: { chainId: deployment.chainId, registryAddress: deployment.registryAddress },
    deployment: null,
    operations: {},
  };

  console.log("\n=== Cost Evaluation ===");
  console.log(`Assumptions: gas price = ${GAS_PRICE_GWEI} gwei, ETH/USD = $${ETH_USD_PRICE}, n = ${NUM_IDENTITIES} trials/op\n`);

  if (typeof deployment.deploymentGasUsed === "number") {
    const deployCost = gasToCost(deployment.deploymentGasUsed);
    report.deployment = { gasUsed: deployment.deploymentGasUsed, eth: deployCost.eth, usd: deployCost.usd };
    console.log(
      `${"contractDeployment".padEnd(24)} gas=${deployment.deploymentGasUsed}` +
        `  ~${deployCost.eth.toFixed(8)} ETH  (~$${deployCost.usd.toFixed(4)})  [one-time]\n`
    );
  }

  for (const [key, samples] of Object.entries(results)) {
    const stats = summarize(samples);
    const meanCost = gasToCost(stats.meanGas);
    report.operations[key] = { ...stats, meanEth: meanCost.eth, meanUsd: meanCost.usd };
    console.log(
      `${key.padEnd(24)} gas[min/mean/max]=${stats.minGas}/${stats.meanGas}/${stats.maxGas}` +
        `  ~${meanCost.eth.toFixed(8)} ETH  (~$${meanCost.usd.toFixed(4)})`
    );
  }

  fs.writeFileSync(
    path.join(__dirname, "..", "results", "cost-evaluation.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  const csvLines = ["operation,n,min_gas,mean_gas,max_gas,mean_eth,mean_usd"];
  if (report.deployment) {
    csvLines.push(
      `contractDeployment,1,${report.deployment.gasUsed},${report.deployment.gasUsed},${report.deployment.gasUsed},${report.deployment.eth},${report.deployment.usd}`
    );
  }
  for (const [key, stats] of Object.entries(report.operations)) {
    csvLines.push(`${key},${stats.n},${stats.minGas},${stats.meanGas},${stats.maxGas},${stats.meanEth},${stats.meanUsd}`);
  }
  fs.writeFileSync(path.join(__dirname, "..", "results", "cost-evaluation.csv"), csvLines.join("\n") + "\n");
  console.log("\nWrote results/cost-evaluation.json and results/cost-evaluation.csv");
}

// EthrDID's write methods resolve to the transaction hash (string), not the
// full receipt, so we look the receipt up ourselves to read `gasUsed`.
async function gasUsedFor(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  return Number(receipt.gasUsed);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
