const path = require("path");
const { Resolver } = require("did-resolver");
const { getResolver } = require("ethr-did-resolver");

// EthrDidResolver isn't part of ethr-did-resolver's public exports (only
// getResolver() is), but resolveAsOfChainHead below needs it directly, so
// we reach into the package's internal module by path.
const ethrResolverIndexPath = require.resolve("ethr-did-resolver");
const { EthrDidResolver } = require(path.join(path.dirname(ethrResolverIndexPath), "resolver.js"));

const NETWORK_NAME = "ehr-local";

function networkConfig(deployment) {
  return {
    name: NETWORK_NAME,
    chainId: deployment.chainId,
    rpcUrl: deployment.rpcUrl,
    registry: deployment.registryAddress,
  };
}

// Wires a standard did-resolver Resolvable to our locally deployed
// EHRRegistry, so did:ethr:0x7a69:... resolves like any ERC-1056 registry.
function buildResolver(deployment) {
  return new Resolver(getResolver({ networks: [networkConfig(deployment)] }));
}

// Exposes changeLog/wrapDidDocument directly instead of going through
// Resolver.resolve(), so resolveAsOfChainHead can pin the document to the
// chain's own head instead of wall-clock time.
function buildEthrResolver(deployment) {
  return new EthrDidResolver({ networks: [networkConfig(deployment)] });
}

// ethr-did-resolver compares each event's block timestamp against real
// wall-clock time. Under Hardhat's automine, several transactions mined
// faster than a second apart push the chain's simulated clock ahead of real
// time, so a just-mined event can look "not yet visible" and get dropped
// from the resolved document. Resolving "as of" the chain's own latest
// block timestamp avoids that.
async function resolveAsOfChainHead(ethrResolver, did, provider) {
  const address = did.split(":").pop();
  const latestBlock = await provider.getBlock("latest");
  const now = Number(latestBlock.timestamp) + 1;
  const { history, controllerKey, chainId } = await ethrResolver.changeLog(address, NETWORK_NAME, "latest");
  const { didDocument, deactivated } = ethrResolver.wrapDidDocument(
    did,
    address,
    controllerKey,
    history,
    chainId,
    "latest",
    now
  );
  return { didDocument, deactivated };
}

module.exports = { buildResolver, buildEthrResolver, resolveAsOfChainHead };
