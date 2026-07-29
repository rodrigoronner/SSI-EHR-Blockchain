const { EthrDID } = require("ethr-did");

// Constructed with a raw privateKey, EthrDID exposes {did, signer, alg} and
// doubles as a did-jwt-vc Issuer directly.
function makeEthrDid(wallet, deployment) {
  return new EthrDID({
    identifier: wallet.address,
    privateKey: wallet.privateKey,
    provider: wallet.provider,
    chainNameOrId: deployment.chainId,
    registry: deployment.registryAddress,
  });
}

module.exports = { makeEthrDid };
