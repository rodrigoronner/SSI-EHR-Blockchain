#!/usr/bin/env python3
"""Generates the Cost/Performance Evaluation figures for the paper directly
from results/cost-evaluation.json, results/performance-evaluation.json, and
results/offchain-performance.json — run this after the benchmark scripts so
the figures always match the numbers actually cited in the text.

Figures are written to results/figures/ by default; pass a directory as the
first argument to write them elsewhere (e.g. next to the paper's source)."""
import json
import os
import subprocess
import sys

import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
FIGDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RESULTS, "figures")
os.makedirs(FIGDIR, exist_ok=True)

# The paper's conceptual figures are set in Latin Modern Sans at 7 pt (6 pt
# for secondary text). Use the same face when a TeX installation provides
# it, so all figures read as one set; otherwise fall back to the default.
def _use_latin_modern_sans():
    try:
        for name in ("lmsans10-regular.otf", "lmsans10-bold.otf"):
            path = subprocess.run(["kpsewhich", name], capture_output=True, text=True).stdout.strip()
            if not path:
                return
            font_manager.fontManager.addfont(path)
        plt.rcParams["font.family"] = "Latin Modern Sans"
    except OSError:
        pass


_use_latin_modern_sans()

# Figures are drawn at their printed size (one column, 8.4 cm), so the type
# sizes below are the sizes that appear on the page.
COLUMN_WIDTH_IN = 8.4 / 2.54

plt.rcParams.update(
    {
        "font.size": 7,
        "axes.titlesize": 7,
        "axes.labelsize": 7,
        "xtick.labelsize": 6,
        "ytick.labelsize": 6,
        "legend.fontsize": 6,
        "axes.linewidth": 0.6,
        "lines.linewidth": 0.9,
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "axes.axisbelow": True,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "grid.alpha": 0.3,
        "grid.linewidth": 0.6,
    }
)

BLUE = "#2c6fbb"
GREY = "#4a4a4a"  # the grey of the conceptual figures


def save(fig, name):
    # Vector PDF for the paper, plus a 600 dpi PNG for submission systems
    # that ask for raster artwork.
    for ext, kwargs in (("pdf", {}), ("png", {"dpi": 600})):
        out = os.path.join(FIGDIR, f"{name}.{ext}")
        fig.savefig(out, **kwargs)
        print("wrote", out)


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

    fig, ax = plt.subplots(figsize=(COLUMN_WIDTH_IN, 2.7))
    y_pos = range(len(ops))
    ax.barh(y_pos, means, xerr=[err_low, err_high], color=BLUE, height=0.6, capsize=2)
    ax.set_yticks(list(y_pos))
    ax.set_yticklabels([labels_map[op] for op in ops])
    ax.invert_yaxis()
    ax.set_xlabel(
        f"Gas used, mean of 5 trials with min–max range\n"
        f"(labels: USD at {data['assumptions']['gasPriceGwei']} gwei, ETH = ${data['assumptions']['ethUsdPrice']:,})"
    )
    ax.xaxis.set_major_formatter(lambda v, _: f"{v / 1000:.0f}k" if v else "0")
    ax.set_xlim(0, max(means) * 1.16)
    for i, (m, u) in enumerate(zip(means, usd)):
        ax.text(m + max(means) * 0.02, i, f"${u:.2f}", va="center", fontsize=6, color=GREY)

    fig.tight_layout()
    save(fig, "cost-evaluation")


def make_performance_figure():
    with open(os.path.join(RESULTS, "performance-evaluation.json")) as f:
        data = json.load(f)
    with open(os.path.join(RESULTS, "offchain-performance.json")) as f:
        offchain = json.load(f)

    # Single column of 4 stacked subplots (rather than a 2x2 grid) so each
    # plot renders at close to the paper's full column width and is legible
    # on its own instead of being squeezed into a quarter of the figure.
    fig, axes = plt.subplots(4, 1, figsize=(COLUMN_WIDTH_IN, 6.6))

    # (a) latency vs mining mode
    modes = [
        ("autoMine", "Auto-mine\n(instant)"),
        ("interval2000ms", "2 s\ninterval"),
        ("interval4000ms", "4 s\ninterval"),
    ]
    means = [data["latency"][k]["mean"] for k, _ in modes]
    ci = [data["latency"][k]["ci95"] for k, _ in modes]
    p95 = [data["latency"][k]["p95"] for k, _ in modes]
    x = range(len(modes))
    width = 0.35
    ax = axes[0]
    ax.bar(
        [i - width / 2 for i in x], means, width=width, yerr=ci, capsize=2,
        label="mean (95% CI)", color=BLUE,
    )
    ax.bar([i + width / 2 for i in x], p95, width=width, label="p95", color=GREY)
    ax.set_xticks(list(x))
    ax.set_xticklabels([label for _, label in modes])
    # Log scale: auto-mine (~40 ms) would otherwise be invisible next to the
    # interval modes (seconds).
    ax.set_yscale("log")
    ax.set_ylabel("Confirmation latency (ms)")
    ax.set_title("(a) On-chain latency vs. mining cadence")
    ax.legend(frameon=False)

    # (b) throughput vs batch size
    ax = axes[1]
    batch_sizes = [row["batchSize"] for row in data["throughput"]]
    tps = [row["txPerSecond"]["mean"] for row in data["throughput"]]
    tps_ci = [row["txPerSecond"]["ci95"] for row in data["throughput"]]
    ax.errorbar(batch_sizes, tps, yerr=tps_ci, marker="o", markersize=3, capsize=2, color=BLUE)
    ax.set_xscale("log")
    ax.set_xlabel("Concurrent batch size")
    ax.set_ylabel("Throughput (tx/s)")
    ax.set_title("(b) On-chain throughput vs. load")
    ax.set_xticks(batch_sizes)
    ax.set_xticklabels([str(b) for b in batch_sizes])

    # (c) off-chain document path, swept across document sizes
    ax = axes[2]
    by_size = offchain["ipfs"]["bySize"]
    sizes = [row["bytes"] for row in by_size]
    stages = [
        ("encrypt", "encrypt", BLUE, "o", "-"),
        ("store", "store (IPFS)", GREY, "s", "-"),
        ("retrieve", "retrieve (IPFS)", GREY, "^", "--"),
        ("decrypt", "decrypt", BLUE, "v", "--"),
    ]
    for key, label, color, marker, style in stages:
        ax.errorbar(
            sizes,
            [row[key]["mean"] for row in by_size],
            yerr=[row[key]["ci95"] for row in by_size],
            marker=marker,
            markersize=3,
            linestyle=style,
            color=color,
            label=label,
            capsize=2,
            elinewidth=0.8,
        )
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("Document size")
    ax.set_ylabel("Latency (ms)")
    ax.set_title("(c) Off-chain document path vs. size")
    ax.set_xticks(sizes)
    ax.set_xticklabels([row["label"].replace(" ", "") for row in by_size])
    ax.legend(frameon=False, ncol=2)

    # (d) VC sign/verify latency
    ax = axes[3]
    vc_labels = ["sign", "verify"]
    vc_means = [offchain["vc"]["sign"]["mean"], offchain["vc"]["verify"]["mean"]]
    vc_ci = [offchain["vc"]["sign"]["ci95"], offchain["vc"]["verify"]["ci95"]]
    ax.bar(vc_labels, vc_means, yerr=vc_ci, capsize=2, color=BLUE, width=0.5)
    ax.set_ylabel("Latency (ms)")
    ax.set_title("(d) VC sign/verify latency")
    for i, (m, e) in enumerate(zip(vc_means, vc_ci)):
        ax.text(i, m + e, f"{m:.2f} ms", ha="center", va="bottom", fontsize=6, color=GREY)
    ax.set_ylim(0, max(m + e for m, e in zip(vc_means, vc_ci)) * 1.2)

    fig.tight_layout(h_pad=1.2)
    save(fig, "performance-evaluation")


if __name__ == "__main__":
    make_cost_figure()
    make_performance_figure()
