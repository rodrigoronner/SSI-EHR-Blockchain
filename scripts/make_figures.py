#!/usr/bin/env python3
"""Generates the Cost/Performance Evaluation figures for the paper directly
from results/cost-evaluation.json and results/performance-evaluation.json —
run this after the benchmark scripts so the figures always match the numbers
actually cited in the text."""
import json
import os

import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
FIGDIR = os.path.join(
    ROOT,
    "Self_Sovereign_Identity_Management_through_Decentralized_Identifiers_and_Verifiable_Credentials",
)

plt.rcParams.update(
    {
        "font.size": 10,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "grid.alpha": 0.3,
        "grid.linewidth": 0.6,
    }
)

BLUE = "#2c6fbb"
GREY = "#555555"


def make_cost_figure():
    with open(os.path.join(RESULTS, "cost-evaluation.json")) as f:
        data = json.load(f)

    labels_map = {
        "addDelegate": "addDelegate",
        "revokeDelegate": "revokeDelegate",
        "setAttributeShort": "setAttribute\n(URL, ~41B)",
        "setAttributeCidLength": "setAttribute\n(IPFS CID, ~59B)",
        "revokeAttribute": "revokeAttribute",
        "changeOwner": "changeOwner",
        "setGuardians": "setGuardians\n(3 guardians)",
        "approveRecoveryNonExecuting": "approveRecovery\n(below threshold)",
        "approveRecoveryExecuting": "approveRecovery\n(executes recovery)",
    }
    ops = list(labels_map.keys())
    means = [data["operations"][op]["meanGas"] for op in ops]
    mins = [data["operations"][op]["minGas"] for op in ops]
    maxs = [data["operations"][op]["maxGas"] for op in ops]
    err_low = [m - lo for m, lo in zip(means, mins)]
    err_high = [hi - m for hi, m in zip(maxs, means)]
    usd = [data["operations"][op]["meanUsd"] for op in ops]

    fig, ax = plt.subplots(figsize=(6.4, 4.8))
    y_pos = range(len(ops))
    ax.barh(y_pos, means, xerr=[err_low, err_high], color=BLUE, height=0.6, capsize=3)
    ax.set_yticks(list(y_pos))
    ax.set_yticklabels([labels_map[op] for op in ops])
    ax.invert_yaxis()
    ax.set_xlabel("Gas used (mean of 5 trials)")
    ax.set_title(
        f"EHRRegistry gas cost per operation\n"
        f"(@ {data['assumptions']['gasPriceGwei']} gwei, ETH = "
        f"${data['assumptions']['ethUsdPrice']:,})"
    )
    for i, (m, u) in enumerate(zip(means, usd)):
        ax.text(m + max(means) * 0.02, i, f"${u:.2f}", va="center", fontsize=9, color=GREY)

    fig.tight_layout()
    out = os.path.join(FIGDIR, "cost-evaluation.pdf")
    fig.savefig(out)
    print("wrote", out)


def make_performance_figure():
    with open(os.path.join(RESULTS, "performance-evaluation.json")) as f:
        data = json.load(f)
    with open(os.path.join(RESULTS, "offchain-performance.json")) as f:
        offchain = json.load(f)

    fig, axes = plt.subplots(2, 2, figsize=(8.6, 6.8))

    # (a) latency vs mining mode
    modes = [
        ("autoMine", "Auto-mine\n(instant)"),
        ("interval2000ms", "2 s\ninterval"),
        ("interval4000ms", "4 s\ninterval"),
    ]
    p50 = [data["latency"][k]["p50Ms"] for k, _ in modes]
    p95 = [data["latency"][k]["p95Ms"] for k, _ in modes]
    x = range(len(modes))
    width = 0.35
    ax = axes[0][0]
    ax.bar([i - width / 2 for i in x], p50, width=width, label="p50", color=BLUE)
    ax.bar([i + width / 2 for i in x], p95, width=width, label="p95", color=GREY)
    ax.set_xticks(list(x))
    ax.set_xticklabels([label for _, label in modes])
    ax.set_ylabel("Confirmation latency (ms)")
    ax.set_title("(a) On-chain latency vs. mining cadence")
    ax.legend(frameon=False, fontsize=8)

    # (b) throughput vs batch size
    ax = axes[0][1]
    batch_sizes = [row["batchSize"] for row in data["throughput"]]
    tps = [row["txPerSecond"] for row in data["throughput"]]
    ax.plot(batch_sizes, tps, marker="o", color=BLUE)
    ax.set_xscale("log")
    ax.set_xlabel("Concurrent batch size")
    ax.set_ylabel("Throughput (tx/s)")
    ax.set_title("(b) On-chain throughput vs. load")
    ax.set_xticks(batch_sizes)
    ax.set_xticklabels([str(b) for b in batch_sizes])

    # (c) IPFS store/retrieve latency
    ax = axes[1][0]
    ipfs_labels = ["store", "retrieve"]
    ipfs_means = [offchain["ipfs"]["store"]["meanMs"], offchain["ipfs"]["retrieve"]["meanMs"]]
    ax.bar(ipfs_labels, ipfs_means, color=BLUE, width=0.5)
    ax.set_ylabel("Latency (ms)")
    ax.set_title("(c) IPFS store/retrieve latency")
    for i, m in enumerate(ipfs_means):
        ax.text(i, m, f"{m:.2f} ms", ha="center", va="bottom", fontsize=8, color=GREY)

    # (d) VC sign/verify latency
    ax = axes[1][1]
    vc_labels = ["sign", "verify"]
    vc_means = [offchain["vc"]["sign"]["meanMs"], offchain["vc"]["verify"]["meanMs"]]
    ax.bar(vc_labels, vc_means, color=BLUE, width=0.5)
    ax.set_ylabel("Latency (ms)")
    ax.set_title("(d) VC sign/verify latency")
    for i, m in enumerate(vc_means):
        ax.text(i, m, f"{m:.2f} ms", ha="center", va="bottom", fontsize=8, color=GREY)

    fig.tight_layout()
    out = os.path.join(FIGDIR, "performance-evaluation.pdf")
    fig.savefig(out)
    print("wrote", out)


if __name__ == "__main__":
    make_cost_figure()
    make_performance_figure()
