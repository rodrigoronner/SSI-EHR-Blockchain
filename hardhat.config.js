require("@nomicfoundation/hardhat-toolbox");

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      // in-process network used by `npx hardhat test`
    },
    localhost: {
      // used by deploy/demo/benchmark scripts against `npx hardhat node`
      url: "http://127.0.0.1:8545",
    },
  },
};
