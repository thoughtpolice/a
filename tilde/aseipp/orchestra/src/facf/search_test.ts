// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Mathematical, API, adversarial, and seeded simulation tests for the FACF port.
 *
 * These carry over the scenarios in `facf/tests.rs` at revision `zrqw`: uniform
 * priors, Bayesian equations, deterministic/flaky convergence, parallel next
 * runs, information-gain weighting, malformed inputs, and numerical stability.
 * Additional regressions cover Rust's tie-breaking and zero-likelihood no-op,
 * defensive snapshots, replay, and recovery after probability underflow.
 * Statistical tests use a local deterministic PRNG instead of Rust `rand`;
 * they validate the same bounds, not identical random streams. No resources,
 * external packages, wall clocks, or celld runtime are needed.
 *
 * @module
 */

import {
  DEFAULT_SEARCH_CONFIG,
  DETERMINISTIC_SEARCH_CONFIG,
  Distribution,
  FacfSearch,
  type SearchConfig,
  type TestResult,
} from "./index.ts";

/** Dependency-free assertion with a useful local failure message. */
function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

/** Compares JSON-safe results, arrays, and ordered execution ledgers. */
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

/** Compares floating-point results to the tolerance used in the Rust tests. */
function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert(
    Math.abs(actual - expected) < tolerance,
    `${actual} is not close to ${expected}`,
  );
}

/** Verifies malformed calls fail with an expected explanatory substring. */
function throws(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(message),
      String(error),
    );
    return;
  }
  throw new Error(`expected error containing ${message}`);
}

/** Checks the complete posterior is finite, nonnegative, and normalized. */
function normalized(search: FacfSearch): void {
  const probabilities = search.probabilities;
  assert(
    probabilities.every((probability) =>
      Number.isFinite(probability) && probability >= 0
    ),
  );
  close(probabilities.reduce((sum, probability) => sum + probability, 0), 1);
  assert(search.distribution.isNormalized());
}

/** Reproducible Mulberry32 random stream; independent from Rust's rand crate. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drives a bounded search under the source algorithm's one-sided noise model. */
function simulate(
  suspects: number,
  culprit: number | null,
  config: Partial<SearchConfig>,
  noise: () => number = () => 1,
  parallelism = 1,
  maxRounds = 100,
): FacfSearch {
  const search = new FacfSearch(suspects, config);
  for (let round = 0; round < maxRounds && search.result() === null; round++) {
    const positions = search.nextRuns(parallelism);
    if (positions.length === 0) break;
    equal(new Set(positions).size, positions.length);
    for (const position of positions) {
      const fails = culprit !== null && position >= culprit;
      const result: TestResult = fails || noise() < search.config.flakeRate
        ? "fail"
        : "pass";
      assert(
        search.recordResult(position, result),
        "consistent simulator produced impossible evidence",
      );
      normalized(search);
    }
  }
  return search;
}

/** Checks a successful inference names the intended suspect. */
function culpritIs(search: FacfSearch, position: number): void {
  const result = search.result();
  assert(
    result?.kind === "culprit",
    `expected culprit, got ${JSON.stringify(result)}`,
  );
  equal(result.position, position);
  assert(result.confidence >= search.config.threshold);
}

Deno.test("FACF distribution uniform prior, CDF, normalization, and accessors", () => {
  for (const count of [1, 4, 5, 10, 100]) {
    const distribution = Distribution.uniform(count);
    equal(distribution.numSuspects, count);
    equal(distribution.probs.length, count + 1);
    assert(distribution.isNormalized());
    const cdf = distribution.cdf();
    for (let position = 0; position <= count; position++) {
      close(distribution.get(position), 1 / (count + 1));
      close(cdf[position], (position + 1) / (count + 1));
      if (position > 0) assert(cdf[position] >= cdf[position - 1]);
    }
    close(cdf[count], 1);
  }
});

Deno.test("FACF distribution maximum selects last tied slot like Rust", () => {
  const distribution = Distribution.fromProbs([0.1, 0.5, 0.2, 0.1, 0.1]);
  equal(distribution.argmax(), 1);
  close(distribution.max(), 0.5);
  equal(Distribution.uniform(4).argmax(), 4);
  equal(Distribution.fromProbs([0.5, 0.5, 0]).argmax(), 1);
});

Deno.test("FACF distribution normalization handles zero and very large weights", () => {
  const zero = Distribution.fromProbs([0, 0]);
  zero.normalize();
  equal(zero.probs, [0, 0]);
  assert(!zero.isNormalized());
  const large = Distribution.fromProbs([Number.MAX_VALUE, Number.MAX_VALUE]);
  large.normalize();
  equal(large.probs, [0.5, 0.5]);
  const raw = Distribution.fromProbs([1, 2, 3, 4]);
  raw.normalize();
  equal(raw.probs, [0.1, 0.2, 0.3, 0.4]);
});

Deno.test("FACF rejects invalid distributions, priors, and suspect counts", () => {
  for (const count of [0, -1, 1.2, NaN, Infinity]) {
    throws(() => new FacfSearch(count), "at least one suspect");
  }
  for (const probabilities of [[], [1]]) {
    throws(() => Distribution.fromProbs(probabilities), "at least 1 suspect");
  }
  for (const probabilities of [[-0.1, 1.1], [NaN, 1], [Infinity, 0]]) {
    throws(
      () => Distribution.fromProbs(probabilities),
      "finite and non-negative",
    );
  }
  throws(() => FacfSearch.withPrior([0.2, 0.2]), "normalized");
  throws(() => FacfSearch.withPrior([0, 0]), "normalized");
  throws(() => Distribution.uniform(1).get(2), "out of range");
});

Deno.test("FACF validates configuration and observations before mutating state", () => {
  for (const value of [-0.1, 1.1, NaN, Infinity]) {
    throws(() => new FacfSearch(2, { flakeRate: value }), "flakeRate");
    throws(() => new FacfSearch(2, { threshold: value }), "threshold");
  }
  const search = new FacfSearch(2);
  for (const position of [-1, 2, 0.5, NaN]) {
    throws(
      () => search.recordResult(position, "pass"),
      "position out of range",
    );
  }
  throws(
    () => search.recordResult(0, "infra_failed" as TestResult),
    "pass or fail",
  );
  for (const parallelism of [-1, 1.5, NaN]) {
    throws(() => search.nextRuns(parallelism), "non-negative safe integer");
  }
  equal(search.iterations, 0);
});

Deno.test("FACF defaults and deterministic settings retain Rust values", () => {
  equal(new FacfSearch(3).config, DEFAULT_SEARCH_CONFIG);
  equal(DEFAULT_SEARCH_CONFIG, {
    flakeRate: 0.01,
    threshold: 0.9,
    useInfoGainWeighting: true,
  });
  equal(DETERMINISTIC_SEARCH_CONFIG, {
    flakeRate: 0,
    threshold: 0.99,
    useInfoGainWeighting: false,
  });
  const search = new FacfSearch(10, {
    flakeRate: 0.15,
    threshold: 0.85,
    useInfoGainWeighting: false,
  });
  equal(search.numSuspects, 10);
  equal(search.config, {
    flakeRate: 0.15,
    threshold: 0.85,
    useInfoGainWeighting: false,
  });
});

Deno.test("FACF manual PASS update matches Rust Equations 8–9", () => {
  const search = new FacfSearch(3, { flakeRate: 0.1 });
  assert(search.recordResult(1, "pass"));
  equal(search.probabilities, [0, 0, 0.5, 0.5]);
  normalized(search);
});

Deno.test("FACF manual FAIL update matches Rust Equations 10–12", () => {
  const search = new FacfSearch(3, { flakeRate: 0.1 });
  assert(search.recordResult(1, "fail"));
  const expected = [0.25 / 0.55, 0.25 / 0.55, 0.025 / 0.55, 0.025 / 0.55];
  search.probabilities.forEach((probability, index) =>
    close(probability, expected[index])
  );
  normalized(search);
});

Deno.test("FACF deterministic PASS and FAIL exclude the appropriate hypotheses", () => {
  const pass = new FacfSearch(8, DETERMINISTIC_SEARCH_CONFIG);
  pass.recordResult(3, "pass");
  pass.probabilities.slice(0, 4).forEach((probability) =>
    equal(probability, 0)
  );
  close(
    pass.probabilities.slice(4).reduce(
      (sum, probability) => sum + probability,
      0,
    ),
    1,
  );
  const fail = new FacfSearch(8, DETERMINISTIC_SEARCH_CONFIG);
  fail.recordResult(3, "fail");
  fail.probabilities.slice(4).forEach((probability) => equal(probability, 0));
  close(
    fail.probabilities.slice(0, 4).reduce(
      (sum, probability) => sum + probability,
      0,
    ),
    1,
  );
});

Deno.test("FACF Bayesian evidence order is commutative for consistent observations", () => {
  const first = new FacfSearch(8, { flakeRate: 0.1 });
  const second = new FacfSearch(8, { flakeRate: 0.1 });
  first.recordResult(2, "pass");
  first.recordResult(5, "fail");
  second.recordResult(5, "fail");
  second.recordResult(2, "pass");
  first.probabilities.forEach((probability, index) =>
    close(probability, second.probabilities[index])
  );
});

Deno.test("FACF repeated PASS is idempotent but distinct FAIL executions add evidence", () => {
  const search = new FacfSearch(8, { flakeRate: 0.2 });
  search.recordResult(2, "pass");
  const before = search.probabilities;
  search.recordResult(2, "pass");
  search.probabilities.forEach((probability, index) =>
    close(probability, before[index])
  );
  let priorMass = search.probabilities.slice(0, 4).reduce(
    (sum, probability) => sum + probability,
    0,
  );
  for (let index = 0; index < 3; index++) {
    search.recordResult(3, "fail");
    const mass = search.probabilities.slice(0, 4).reduce(
      (sum, probability) => sum + probability,
      0,
    );
    assert(mass > priorMass);
    priorMass = mass;
  }
  assert(priorMass > 0.9);
  equal(search.iterations, 5);
});

Deno.test("FACF next runs selects a median and distinct quantile positions", () => {
  const search = new FacfSearch(10, DETERMINISTIC_SEARCH_CONFIG);
  const [median] = search.nextRuns(1);
  assert(median >= 3 && median <= 5);
  equal(search.nextRuns(0), []);
  const larger = new FacfSearch(16, DETERMINISTIC_SEARCH_CONFIG);
  equal(larger.nextRuns(2).length, 2);
  for (const parallelism of [1, 2, 3, 4, 10, 100]) {
    const runs = larger.nextRuns(parallelism);
    assert(runs.length <= Math.min(parallelism, 16));
    equal(new Set(runs).size, runs.length);
    assert(runs.every((position) => position >= 0 && position < 16));
  }
});

Deno.test("FACF prefer-prior heuristic and narrowed posterior match Rust", () => {
  const search = FacfSearch.withPrior([0.1, 0.1, 0.6, 0.1, 0.1], {
    useInfoGainWeighting: false,
  });
  equal(search.nextRuns(1), [1]);
  equal(search.nextRuns(3), [1, 2]);
  const narrowed = new FacfSearch(16, DETERMINISTIC_SEARCH_CONFIG);
  narrowed.recordResult(7, "pass");
  assert(narrowed.nextRuns(1)[0] > 7);
});

Deno.test("FACF Equation 13 weighting excludes no-culprit and changes selection", () => {
  const search = new FacfSearch(16, { flakeRate: 0.1 });
  const weighted = search.computeInfoGainWeightedCdf();
  assert(weighted !== null);
  equal(weighted.length, 16);
  close(weighted[15], 1);
  const rawWeights = Array.from(
    { length: 16 },
    (_, index) => 0.9 * (16 + (index + 1) * 0.1 - 1) / 17,
  );
  const sum = rawWeights.reduce((total, weight) => total + weight, 0);
  let accumulated = 0;
  weighted.forEach((probability, index) =>
    close(probability, accumulated += rawWeights[index] / sum)
  );
  assert(
    weighted.some((probability, index) =>
      Math.abs(probability - search.distribution.cdf()[index]) > 1e-9
    ),
  );
  const optimized = new FacfSearch(32, { flakeRate: 0.2 });
  const plain = new FacfSearch(32, {
    flakeRate: 0.2,
    useInfoGainWeighting: false,
  });
  optimized.recordResult(20, "fail");
  plain.recordResult(20, "fail");
  assert(
    [1, 2, 3, 4, 5].some((count) =>
      JSON.stringify(optimized.nextRuns(count)) !==
        JSON.stringify(plain.nextRuns(count))
    ),
  );
});

Deno.test("FACF weighted selection falls back when all information weights vanish", () => {
  const certainFlake = FacfSearch.withPrior([0, 0, 1]);
  equal(certainFlake.computeInfoGainWeightedCdf(), null);
  equal(certainFlake.nextRuns(1), []);
  const noInformation = new FacfSearch(4, { flakeRate: 1 });
  equal(noInformation.computeInfoGainWeightedCdf(), null);
  equal(
    noInformation.nextRuns(1),
    new FacfSearch(4, { useInfoGainWeighting: false }).nextRuns(1),
  );
});

Deno.test("FACF empty next-runs does not imply threshold-qualified completion", () => {
  const search = FacfSearch.withPrior([0.1, 0.1, 0.8], {
    useInfoGainWeighting: false,
    threshold: 0.9,
  });
  equal(search.nextRuns(1), []);
  equal(search.result(), null);
  // An orchestrator may explicitly probe the newest suspect when budget allows.
  search.recordResult(1, "pass");
  equal(search.result(), { kind: "no_culprit", confidence: 1 });
});

Deno.test("FACF deterministic search finds first, middle, last, and every small culprit", () => {
  for (const size of [1, 2, 8, 16, 32]) {
    for (let culprit = 0; culprit < size; culprit++) {
      const search = simulate(size, culprit, DETERMINISTIC_SEARCH_CONFIG);
      culpritIs(search, culprit);
      assert(
        search.iterations <= 10,
        `${size} suspects took ${search.iterations} executions`,
      );
    }
  }
});

Deno.test("FACF deterministic search scales to a thousand suspects", () => {
  const search = simulate(1000, 500, DETERMINISTIC_SEARCH_CONFIG);
  culpritIs(search, 500);
  assert(search.iterations <= 15);
});

Deno.test("FACF all passing test runs conclude no culprit", () => {
  for (const flakeRate of [0, 0.01, 0.1, 0.9]) {
    const search = simulate(8, null, { flakeRate });
    equal(search.result(), { kind: "no_culprit", confidence: 1 });
    assert(search.iterations < 20);
  }
});

Deno.test("FACF weighted and plain selection both find a clean regression", () => {
  for (const useInfoGainWeighting of [false, true]) {
    culpritIs(simulate(32, 16, { flakeRate: 0.1, useInfoGainWeighting }), 16);
  }
});

Deno.test("FACF high flake rates need repeated failures to reach confidence", () => {
  const search = new FacfSearch(8, { flakeRate: 0.9, threshold: 0.95 });
  search.recordResult(3, "pass");
  for (let run = 0; run < 100 && search.result() === null; run++) {
    search.recordResult(4, "fail");
  }
  culpritIs(search, 4);
  assert(search.iterations > 20);
});

Deno.test("FACF exact threshold is inclusive and last tied hypothesis wins", () => {
  const search = FacfSearch.withPrior([0.5, 0.5, 0], { threshold: 0.5 });
  equal(search.result(), { kind: "culprit", position: 1, confidence: 0.5 });
  equal(new FacfSearch(1, { threshold: 0.5 }).result(), {
    kind: "no_culprit",
    confidence: 0.5,
  });
  equal(new FacfSearch(1, { threshold: 0 }).result(), {
    kind: "no_culprit",
    confidence: 0.5,
  });
  const exact = new FacfSearch(1, { flakeRate: 0, threshold: 1 });
  exact.recordResult(0, "fail");
  culpritIs(exact, 0);
});

Deno.test("FACF custom prior applies the same Bayes likelihoods", () => {
  const search = FacfSearch.withPrior([0.1, 0.2, 0.3, 0.4], {
    flakeRate: 0.25,
  });
  search.recordResult(1, "fail");
  const weights = [0.1, 0.2, 0.075, 0.1];
  const total = weights.reduce((sum, probability) => sum + probability, 0);
  search.probabilities.forEach((probability, index) =>
    close(probability, weights[index] / total)
  );
  search.recordResult(1, "pass");
  close(search.probabilities[2], 3 / 7);
  close(search.probabilities[3], 4 / 7);
});

Deno.test("FACF zero-likelihood observations are observable but keep Rust's no-op posterior", () => {
  const deterministic = new FacfSearch(3, DETERMINISTIC_SEARCH_CONFIG);
  deterministic.recordResult(0, "fail");
  const before = deterministic.probabilities;
  assert(!deterministic.recordResult(1, "pass"));
  equal(deterministic.probabilities, before);
  equal(deterministic.iterations, 2);
  const alwaysFails = new FacfSearch(3, { flakeRate: 1 });
  assert(!alwaysFails.recordResult(2, "pass"));
  equal(alwaysFails.probabilities, [0.25, 0.25, 0.25, 0.25]);
  assert(alwaysFails.recordResult(0, "fail"));
  equal(alwaysFails.probabilities, [0.25, 0.25, 0.25, 0.25]);
  equal(alwaysFails.result(), null);
});

Deno.test("FACF a later PASS can explain an earlier FAIL as a flake", () => {
  const search = new FacfSearch(8, { flakeRate: 0.5 });
  search.recordResult(4, "fail");
  search.recordResult(5, "pass");
  search.probabilities.slice(0, 6).forEach((probability) =>
    equal(probability, 0)
  );
  normalized(search);
  const adjacent = new FacfSearch(8, DETERMINISTIC_SEARCH_CONFIG);
  adjacent.recordResult(4, "pass");
  adjacent.recordResult(5, "fail");
  culpritIs(adjacent, 5);
});

Deno.test("FACF execution ledger and posterior replay are deterministic", () => {
  const original = new FacfSearch(8, { flakeRate: 0.1 });
  original.recordResult(3, "pass");
  original.recordResult(5, "fail");
  original.recordResult(4, "fail");
  equal(original.executions, [
    { position: 3, result: "pass" },
    { position: 5, result: "fail" },
    { position: 4, result: "fail" },
  ]);
  const replay = new FacfSearch(original.numSuspects, original.config);
  for (const execution of original.executions) {
    replay.recordResult(execution.position, execution.result);
  }
  equal(replay.probabilities, original.probabilities);
  equal(replay.nextRuns(3), original.nextRuns(3));
  equal(replay.result(), original.result());
});

Deno.test("FACF public snapshots cannot mutate inference state", () => {
  const prior = [0.1, 0.2, 0.3, 0.4];
  const search = FacfSearch.withPrior(prior);
  const before = search.probabilities;
  prior[0] = 1;
  search.probabilities[0] = 1;
  search.distribution.probs[0] = 1;
  equal(search.probabilities, before);
  search.recordResult(0, "pass");
  search.executions.push({ position: 2, result: "fail" });
  equal(search.iterations, 1);
  assert(Object.isFrozen(search.config));
});

Deno.test("FACF long failure streak does not erase recoverable hypotheses", () => {
  const search = new FacfSearch(3, { flakeRate: 0.01 });
  for (let index = 0; index < 2000; index++) search.recordResult(0, "fail");
  equal(search.probabilities[1], 0); // Snapshot underflows; internal log weight does not.
  assert(search.recordResult(0, "pass"));
  equal(search.probabilities[0], 0);
  search.probabilities.slice(1).forEach((probability) =>
    close(probability, 1 / 3)
  );
  normalized(search);
});

Deno.test("FACF tiny positive flake rates remain distinguishable from zero", () => {
  const search = new FacfSearch(2, { flakeRate: Number.MIN_VALUE });
  search.recordResult(0, "fail");
  search.recordResult(0, "fail");
  assert(search.recordResult(0, "pass"));
  equal(search.probabilities, [0, 0.5, 0.5]);
});

Deno.test("FACF adversarial repeated and alternating outcomes remain normalized", () => {
  const search = new FacfSearch(20, { flakeRate: 0.3 });
  for (let index = 0; index < 500; index++) {
    search.recordResult(index % 20, index % 3 === 0 ? "pass" : "fail");
    normalized(search);
  }
  const allFail = new FacfSearch(8, { flakeRate: 0.1 });
  for (let position = 0; position < 8; position++) {
    allFail.recordResult(position, "fail");
  }
  equal(allFail.distribution.argmax(), 0);
});

Deno.test("FACF seeded low-noise Monte Carlo retains Rust accuracy and iteration bounds", () => {
  const noise = random(123);
  let correct = 0;
  let iterations = 0;
  let maxIterations = 0;
  for (let run = 0; run < 100; run++) {
    const culprit = Math.floor(noise() * 32);
    const search = simulate(32, culprit, { flakeRate: 0.05 }, noise);
    const result = search.result();
    if (result?.kind === "culprit" && result.position === culprit) correct++;
    iterations += search.iterations;
    maxIterations = Math.max(maxIterations, search.iterations);
  }
  assert(correct >= 80, `only ${correct}/100 correct`);
  assert(iterations / 100 < 20, `average iterations ${iterations / 100}`);
  assert(maxIterations < 50, `maximum iterations ${maxIterations}`);
});

Deno.test("FACF seeded accuracy remains bounded across flake rates", () => {
  const noise = random(789);
  for (const flakeRate of [0, 0.05, 0.1, 0.2, 0.3]) {
    let correct = 0;
    let wrong = 0;
    for (let run = 0; run < 100; run++) {
      const culprit = Math.floor(noise() * 16);
      const search = simulate(16, culprit, { flakeRate }, noise);
      const result = search.result();
      if (result?.kind === "culprit") {
        if (result.position === culprit) correct++;
        else wrong++;
      }
    }
    if (flakeRate <= 0.1) {
      assert(correct >= 70, `${correct}% accuracy at f=${flakeRate}`);
    }
    assert(wrong < 15, `${wrong}% wrong at f=${flakeRate}`);
  }
});

Deno.test("FACF high-noise confidence limits wrong conclusions", () => {
  const noise = random(456);
  let wrong = 0;
  for (let run = 0; run < 100; run++) {
    const culprit = Math.floor(noise() * 8);
    const search = simulate(
      8,
      culprit,
      { flakeRate: 0.3, threshold: 0.95 },
      noise,
    );
    const result = search.result();
    if (result?.kind === "culprit" && result.position !== culprit) wrong++;
  }
  assert(wrong < 10, `${wrong}% wrong at f=0.3 and threshold=0.95`);
});

Deno.test("FACF seeded parallel batches converge without duplicate positions", () => {
  const noise = random(2002);
  for (const parallelism of [1, 3]) {
    let converged = 0;
    for (let run = 0; run < 50; run++) {
      const culprit = Math.floor(noise() * 64);
      const search = simulate(
        64,
        culprit,
        { flakeRate: 0.05 },
        noise,
        parallelism,
      );
      if (search.result() !== null) converged++;
    }
    assert(
      converged >= 45,
      `only ${converged}/50 converged with k=${parallelism}`,
    );
  }
});
