const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Deploys EHRRegistry against whatever network Hardhat was invoked with
// (intended usage: `npx hardhat run scripts/deploy.js --network localhost`,
// pointed at a `npx hardhat node` instance) and writes the resulting address
// to deployment.json so the plain-Node scripts (demo, VC, IPFS, benchmarks)
// can pick it up without depending on the Hardhat runtime themselves.
async function main() {
  const network = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();

  const EHRRegistry = await hre.ethers.getContractFactory("EHRRegistry");
  const registry = await EHRRegistry.deploy();
  const deployTx = registry.deploymentTransaction();
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  const deployReceipt = await deployTx.wait();

  const deploymentInfo = {
    network,
    rpcUrl: hre.network.config.url || "http://127.0.0.1:8545",
    chainId: Number(chainId),
    registryAddress: address,
    deployedAt: new Date().toISOString(),
    deploymentGasUsed: Number(deployReceipt.gasUsed),
  };

  fs.writeFileSync(
    path.join(__dirname, "..", "deployment.json"),
    JSON.stringify(deploymentInfo, null, 2) + "\n"
  );

  console.log("EHRRegistry deployed:", deploymentInfo);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
