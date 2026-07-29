// Shared descriptive statistics for the benchmarks.
//
// Confidence intervals use Student's t rather than the normal approximation
// because these samples are small: at n = 3 the two-sided 95% critical value
// is 4.303 against 1.96 for the normal, so using z here would understate the
// interval by more than a factor of two.

// Two-sided 95% critical values indexed by degrees of freedom (n - 1).
const T_95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
  40: 2.021, 60: 2.000, 120: 1.980,
};

function tCritical95(df) {
  if (df < 1) return NaN;
  if (T_95[df] !== undefined) return T_95[df];
  // Between tabulated points, take the next larger tabulated df, which is
  // conservative (a slightly wider interval) rather than optimistic.
  const keys = Object.keys(T_95).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    if (df < k) return T_95[k];
  }
  return 1.96; // df > 120: the normal approximation is adequate
}

function percentile(sortedValues, p) {
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// Returns mean, sample standard deviation, and the half-width of the 95%
// confidence interval on the mean. `round` controls the reported precision;
// raw samples are never rounded before the statistics are computed.
function summarize(samples, round = 3) {
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / n;

  // Sample standard deviation (n-1 denominator); undefined for a single
  // observation, in which case no interval can be estimated.
  let sd = 0;
  let ci95 = null;
  if (n > 1) {
    const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
    sd = Math.sqrt(variance);
    ci95 = tCritical95(n - 1) * (sd / Math.sqrt(n));
  }

  const r = (x) => (x === null ? null : Number(x.toFixed(round)));
  return {
    n,
    mean: r(mean),
    sd: r(sd),
    ci95: r(ci95),
    ciLow: r(ci95 === null ? null : mean - ci95),
    ciHigh: r(ci95 === null ? null : mean + ci95),
    min: r(sorted[0]),
    max: r(sorted[n - 1]),
  };
}

// Same as summarize, plus the percentiles that matter for latency, where the
// tail is more informative than the mean.
function summarizeLatency(samples, round = 3) {
  const sorted = [...samples].sort((a, b) => a - b);
  const r = (x) => Number(x.toFixed(round));
  return {
    ...summarize(samples, round),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
  };
}

// "12.34 +/- 0.56" for console output; falls back gracefully at n = 1.
function formatCi(stats, unit = "ms") {
  if (stats.ci95 === null) return `${stats.mean} ${unit} (n=1)`;
  return `${stats.mean} +/- ${stats.ci95} ${unit}`;
}

module.exports = { summarize, summarizeLatency, formatCi, tCritical95, percentile };
