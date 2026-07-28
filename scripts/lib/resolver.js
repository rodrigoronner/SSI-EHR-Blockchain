const path = require("path");
const { Resolver } = require("did-resolver");
const { getResolver } = require("ethr-did-resolver");

// `EthrDidResolver` (the class that does the actual on-chain event-log
// decoding and DID Document assembly) is not part of ethr-did-resolver's
// public package exports — only the `getResolver()` factory (used to build
// a did-resolver-compatible `Resolvable`) is. We need the class directly
// for `resolveAsOfChainHead` below (see its comment for why), so we reach
// into the package's own internal module file by absolute path.
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

// Builds a standards-compliant DID resolver (`did-resolver`'s Resolvable
// interface) wired to our locally deployed EHRRegistry, so `did:ethr:0x7a69:...`
// identities on the Hardhat local network resolve exactly like they would
// against any other ERC-1056-compatible registry. Suitable for VC
// verification (only ever needs the always-present `#controller` key).
function buildResolver(deployment) {
  return new Resolver(getResolver({ networks: [networkConfig(deployment)] }));
}

// Exposes `changeLog`/`wrapDidDocument` directly (see resolveAsOfChainHead)
// instead of going through `Resolver.resolve()`'s DID query-string
// round-trip, so callers can pin the document to the chain's own head
// instead of real wall-clock time.
function buildEthrResolver(deployment) {
  return new EthrDidResolver({ networks: [networkConfig(deployment)] });
}

// `ethr-did-resolver` compares each event's on-chain block timestamp against
// REAL wall-clock time by default (not the local chain's simulated clock).
// Hardhat's automine guarantees each new block's timestamp is strictly
// greater than the previous one, so several transactions mined faster than
// 1 real second apart push the chain's simulated clock ahead of real time —
// any event whose `blockTimestamp` ends up in that gap would (per the
// library's own rules) be treated as "not yet visible" and left out of the
// resolved DID Document, making demo/benchmark output flaky on a fast local
// node. Reading the chain's own latest block timestamp and resolving "as of"
// that moment sidesteps wall-clock timing entirely. (The other half of that
// flakiness was ethers' own 250ms request cache serving a `getBlock("latest")`
// that predated a transaction confirmed moments earlier — see the
// `cacheTimeout: -1` note in lib/network.js's getProvider.)
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
