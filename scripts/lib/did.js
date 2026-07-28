const { EthrDID } = require("ethr-did");

// `EthrDID` instances double as a did-jwt-vc `Issuer` ({did, signer, alg}) —
// when constructed with `privateKey`, EthrDID sets `signer` to an ES256K-R
// (recoverable) signer and `alg` to 'ES256K-R', which is exactly the scheme
// needed to verify a signature against a did:ethr's `blockchainAccountId`
// (no separate public key material is published on-chain).
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
