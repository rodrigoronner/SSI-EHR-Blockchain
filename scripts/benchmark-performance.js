const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadDeployment, getProvider, deriveWallet, createNonceTracker } = require("./lib/network");

// Performance Evaluation (paper Section "Results and Discussion"). Two
// separate questions, measured separately against a running `npx hardhat
// node`:
//   1) Latency: how does the network's mining cadence affect confirmation
//      time for a single transaction? (auto-mine vs. fixed block intervals)
//   2) Throughput/scalability: how many EHRRegistry operations per second
//      can the network sustain as concurrent load grows?
// Both use plain `ethers.Contract` calls (no EthrDID wrapper) so we measure
// the contract/network's own cost, not one client library's overhead.

const artifact = require("../artifacts/contracts/EHRRegistry.sol/EHRRegistry.json");
const NUM_POOL_WALLETS = 20; // Hardhat's default node only funds indices 0-19
const LATENCY_SAMPLES_PER_MODE = 8;
const THROUGHPUT_BATCH_SIZES = [10, 50, 100, 500];

function percentile(sortedValues, p) {
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

function summarizeLatencies(latenciesMs) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

async function setMining(provider, mode) {
  if (mode.type === "auto") {
    await provider.send("evm_setIntervalMining", [0]);
    await provider.send("evm_setAutomine", [true]);
  } else {
    await provider.send("evm_setAutomine", [false]);
    await provider.send("evm_setIntervalMining", [mode.ms]);
    // Force a fresh interval boundary so the first sample isn't measured
    // against whatever cycle was already in progress under the previous
    // mining mode's timer.
    await provider.send("evm_mine", []);
  }
}

let attributeCounter = 0;
function uniqueAttributeCall(registryContract, wallet, nonce) {
  attributeCounter += 1;
  const name = ethers.encodeBytes32String(`bench-${attributeCounter}`.slice(0, 31));
  const value = ethers.toUtf8Bytes(`benchmark-value-${attributeCounter}`);
  return registryContract
    .connect(wallet)
    .setAttribute(wallet.address, name, value, 3600, { nonce, gasLimit: 150000 });
}

async function runLatencyMode(provider, registryContract, wallet, nextNonce, mode, label) {
  const latencies = [];
  for (let i = 0; i < LATENCY_SAMPLES_PER_MODE; i++) {
    const nonce = await nextNonce(wallet.address);
    const start = Date.now();
    const tx = await uniqueAttributeCall(registryContract, wallet, nonce);
    await tx.wait();
    latencies.push(Date.now() - start);
  }
  const stats = summarizeLatencies(latencies);
  console.log(
    `${label.padEnd(28)} p50=${stats.p50Ms}ms  p95=${stats.p95Ms}ms  p99=${stats.p99Ms}ms  min=${stats.minMs}ms  max=${stats.maxMs}ms`
  );
  return stats;
}

async function runThroughputBatch(provider, registryContract, wallets, nextNonce, batchSize) {
  const start = Date.now();
  // Group call indices by wallet: Hardhat's automine can't queue
  // out-of-order transactions from the same account, so each wallet's own
  // sends must be issued strictly in nonce order. Different wallets' send
  // sequences still run concurrently, which is what actually parallelizes
  // the batch.
  const byWallet = new Map();
  for (let i = 0; i < batchSize; i++) {
    const wallet = wallets[i % wallets.length];
    if (!byWallet.has(wallet)) byWallet.set(wallet, []);
    byWallet.get(wallet).push(i);
  }

  const allTxs = [];
  const walletSequences = Array.from(byWallet.values()).map(async (indices) => {
    for (const i of indices) {
      const wallet = wallets[i % wallets.length];
      const nonce = await nextNonce(wallet.address);
      allTxs.push(await uniqueAttributeCall(registryContract, wallet, nonce));
    }
  });
  await Promise.all(walletSequences);
  await Promise.all(allTxs.map((tx) => tx.wait()));
  const elapsedSeconds = (Date.now() - start) / 1000;
  return { batchSize, elapsedSeconds, txPerSecond: batchSize / elapsedSeconds };
}

async function main() {
  const deployment = loadDeployment();
  const provider = getProvider(deployment);
  const nextNonce = createNonceTracker(provider);
  const registryContract = new ethers.Contract(deployment.registryAddress, artifact.abi, provider);

  const pool = Array.from({ length: NUM_POOL_WALLETS }, (_, i) => deriveWallet(i, provider));

  const report = { latency: {}, throughput: [] };

  console.log("\n=== Performance Evaluation: latency vs. mining cadence ===");
  await setMining(provider, { type: "auto" });
  report.latency.autoMine = await runLatencyMode(provider, registryContract, pool[0], nextNonce, { type: "auto" }, "auto-mine");

  for (const ms of [2000, 4000]) {
    await setMining(provider, { type: "interval", ms });
    report.latency[`interval${ms}ms`] = await runLatencyMode(
      provider,
      registryContract,
      pool[0],
      nextNonce,
      { type: "interval", ms },
      `interval mining (${ms}ms blocks)`
    );
  }

  // Restore automine for the throughput/scalability section — we want to
  // measure the network's raw processing capacity, not an artificial
  // block-time ceiling.
  await setMining(provider, { type: "auto" });

  console.log("\n=== Performance Evaluation: throughput / scalability (auto-mine) ===");
  for (const batchSize of THROUGHPUT_BATCH_SIZES) {
    const result = await runThroughputBatch(provider, registryContract, pool, nextNonce, batchSize);
    report.throughput.push(result);
    console.log(
      `batch=${String(batchSize).padEnd(4)} elapsed=${result.elapsedSeconds.toFixed(3)}s` +
        `  throughput=${result.txPerSecond.toFixed(2)} tx/s`
    );
  }

  fs.writeFileSync(
    path.join(__dirname, "..", "results", "performance-evaluation.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  const csvLines = ["batch_size,elapsed_seconds,tx_per_second"];
  for (const row of report.throughput) {
    csvLines.push(`${row.batchSize},${row.elapsedSeconds},${row.txPerSecond}`);
  }
  fs.writeFileSync(path.join(__dirname, "..", "results", "performance-evaluation.csv"), csvLines.join("\n") + "\n");
  console.log("\nWrote results/performance-evaluation.json and results/performance-evaluation.csv");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Leave the node in a normal state for whatever runs next.
    try {
      const deployment = loadDeployment();
      const provider = getProvider(deployment);
      await provider.send("evm_setIntervalMining", [0]);
      await provider.send("evm_setAutomine", [true]);
    } catch {
      // best-effort cleanup only
    }
  });
