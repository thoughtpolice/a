// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::distribution::*;

/// Represents a test result at a specific position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestResult {
    Pass,
    Fail,
}

/// Execution record: position and result.
#[derive(Debug, Clone)]
pub struct Execution {
    pub position: usize,
    pub result: TestResult,
}

/// Configuration for FACF.
#[derive(Debug, Clone)]
pub struct SearchConfig {
    /// Estimated flake rate (0.0 to 1.0).
    ///
    /// This is the probability that a test fails due to flakiness rather than
    /// an actual bug. A value of 0.0 means tests are perfectly deterministic
    /// (like traditional bisect). A value of 0.1 means 10% of failures are
    /// random flakes.
    pub flake_rate: f64,

    /// Confidence threshold for termination (0.0 to 1.0).
    ///
    /// The algorithm terminates when the maximum probability in the distribution
    /// exceeds this threshold. A value of 0.9 means 90% confidence is required.
    pub threshold: f64,

    /// Use information-gain optimized thresholds in NextRuns.
    ///
    /// If true, use Equation 13 from the paper to bias toward positions where
    /// a PASS is more likely (providing stronger evidence). If false, use
    /// uniform thresholds.
    pub use_info_gain_weighting: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            flake_rate: 0.01,
            threshold: 0.9,
            use_info_gain_weighting: true,
        }
    }
}

impl SearchConfig {
    /// Create a config with the given flake rate.
    pub fn with_flake_rate(flake_rate: f64) -> Self {
        Self {
            flake_rate,
            ..Default::default()
        }
    }

    /// Create a deterministic config (flake_rate = 0, like traditional bisect).
    pub fn deterministic() -> Self {
        Self {
            flake_rate: 0.0,
            threshold: 0.99,
            use_info_gain_weighting: false,
        }
    }
}

/// Result of FACF search.
#[derive(Debug, Clone, PartialEq)]
pub enum SearchResult {
    /// Found culprit at this position (0-indexed), with confidence level.
    Culprit { position: usize, confidence: f64 },
    /// No culprit - original failure was likely a flake.
    NoCulprit { confidence: f64 },
}

/// The FACF algorithm state machine.
///
/// This implements Algorithm 2 (FlakeAware) from the paper. The caller drives
/// the algorithm by repeatedly:
/// 1. Calling `next_runs()` to get positions to test
/// 2. Running tests at those positions
/// 3. Calling `record_result()` with the outcomes
/// 4. Checking `result()` to see if we're done
#[derive(Clone)]
pub struct State {
    config: SearchConfig,
    num_suspects: usize,
    distribution: Distribution,
    executions: Vec<Execution>,
}

impl State {
    /// Create a new FACF instance with `n` suspects.
    ///
    /// Suspects are numbered 0 to n-1. The algorithm will determine which
    /// (if any) is the culprit.
    pub fn new(num_suspects: usize, config: SearchConfig) -> Self {
        assert!(num_suspects > 0, "must have at least one suspect");
        assert!(
            (0.0..=1.0).contains(&config.flake_rate),
            "flake_rate must be in [0, 1]"
        );
        assert!(
            (0.0..=1.0).contains(&config.threshold),
            "threshold must be in [0, 1]"
        );

        Self {
            config,
            num_suspects,
            distribution: Distribution::uniform(num_suspects),
            executions: Vec::new(),
        }
    }

    /// Create a new FACF instance with a custom prior distribution.
    ///
    /// The prior must have at least 2 entries (1 suspect + no-culprit) and
    /// be normalized (probabilities sum to 1.0).
    pub fn with_prior(prior: Distribution, config: SearchConfig) -> Self {
        assert!(
            prior.probs().len() >= 2,
            "prior must have at least 2 entries (1 suspect + no-culprit)"
        );
        assert!(
            prior.is_normalized(),
            "prior must be normalized (probabilities must sum to 1.0)"
        );
        assert!(
            (0.0..=1.0).contains(&config.flake_rate),
            "flake_rate must be in [0, 1]"
        );
        assert!(
            (0.0..=1.0).contains(&config.threshold),
            "threshold must be in [0, 1]"
        );

        let num_suspects = prior.num_suspects();

        Self {
            config,
            num_suspects,
            distribution: prior,
            executions: Vec::new(),
        }
    }

    /// Get the next position(s) to test (Algorithm 3: NextRuns).
    ///
    /// `k` is the number of parallel runs desired. Returns up to `k` positions
    /// to test. May return fewer than `k` or even empty if no more tests are
    /// useful.
    pub fn next_runs(&self, k: usize) -> Vec<usize> {
        if k == 0 {
            return Vec::new();
        }

        let n = self.num_suspects;

        // Always use uniform thresholds: {i/(k+1) | i = 1..k}
        let thresholds: Vec<f64> = (1..=k).map(|i| i as f64 / (k + 1) as f64).collect();

        // Probability CDF (used for prefer-prior check and as fallback)
        let prob_cdf = self.distribution.cdf();

        // Selection CDF: info-gain-weighted if enabled, else plain posterior.
        // The info-gain CDF biases position selection toward suspects where
        // testing yields the most expected information (Section III-B).
        let selection_cdf: Vec<f64> =
            if self.config.use_info_gain_weighting && self.config.flake_rate > 0.0 {
                self.compute_info_gain_weighted_cdf()
                    .unwrap_or_else(|| prob_cdf[..n].to_vec())
            } else {
                prob_cdf[..n].to_vec()
            };

        let mut runs = Vec::new();
        let mut tidx = 0;

        // Iterate through selection CDF, selecting positions that cross thresholds
        #[allow(clippy::needless_range_loop)]
        for cidx in 0..n {
            if tidx >= thresholds.len() {
                break;
            }

            while tidx < thresholds.len() && selection_cdf[cidx] >= thresholds[tidx] {
                // Optimization from paper (Algorithm 3, line 9):
                // Prefer testing cidx-1 to find a PASS before the likely culprit.
                // Only apply if cidx-1 is not already in the current batch and
                // has nonzero cumulative probability in the posterior.
                let selected =
                    if cidx > 0 && !runs.contains(&(cidx - 1)) && prob_cdf[cidx - 1] > 0.0 {
                        cidx - 1
                    } else {
                        cidx
                    };

                // Avoid duplicates in the same batch
                if !runs.contains(&selected) {
                    runs.push(selected);
                }
                tidx += 1;
            }
        }

        runs
    }

    /// Compute information-gain weighted CDF for position selection (Section III-B).
    ///
    /// Per Equation 13, `E[I(sᵢ)] = (1 - f̂) × (n + (i+1)×f̂ - 1)`. We weight
    /// each suspect by `E[I(sᵢ)] × Pr[Cᵢ]`, normalize, and accumulate into a
    /// CDF. The no-culprit slot gets zero weight since we can't test "no culprit".
    ///
    /// Returns `None` if the weighted distribution is all zeros (degenerate case).
    pub fn compute_info_gain_weighted_cdf(&self) -> Option<Vec<f64>> {
        let n = self.num_suspects;
        let f = self.config.flake_rate;

        // weighted[i] = E[I(sᵢ)] × Pr[Cᵢ]
        let mut weighted: Vec<f64> = (0..n)
            .map(|i| {
                let info_gain = (1.0 - f) * (n as f64 + (i + 1) as f64 * f - 1.0);
                info_gain * self.distribution.get(i)
            })
            .collect();

        let total: f64 = weighted.iter().sum();
        if total <= 0.0 {
            return None;
        }

        for w in &mut weighted {
            *w /= total;
        }

        // Build CDF
        let mut cdf = Vec::with_capacity(n);
        let mut cumsum = 0.0;
        for &w in &weighted {
            cumsum += w;
            cdf.push(cumsum);
        }

        Some(cdf)
    }

    /// Record a test result and update the probability distribution.
    ///
    /// This applies Bayesian updates from Equations 8-12 in the paper.
    pub fn record_result(&mut self, position: usize, result: TestResult) {
        assert!(position < self.num_suspects, "position out of range");

        self.executions.push(Execution { position, result });

        match result {
            TestResult::Pass => self.apply_pass_update(position),
            TestResult::Fail => self.apply_fail_update(position),
        }
    }

    /// Apply Bayesian update for a PASS at position k (Equations 8-9).
    ///
    /// Pr[Pₖ | Cⱼ] = { 1 - f̂   if k < j    (can pass before culprit)
    ///              { 0       otherwise  (cannot pass at or after culprit)
    ///
    /// This zeros out positions 0..=k and scales positions k+1..n.
    fn apply_pass_update(&mut self, k: usize) {
        let n = self.num_suspects;
        let f = self.config.flake_rate;

        // Compute Pr[Pₖ] = Σⱼ₌ₖ₊₁ⁿ⁺¹ (1 - f̂) × Pr[Cⱼ]
        // (sum over positions after k, including no-culprit)
        let pr_pk: f64 = (k + 1..=n)
            .map(|j| (1.0 - f) * self.distribution.get(j))
            .sum();

        if pr_pk <= 0.0 {
            return;
        }

        let probs = self.distribution.probs_mut();
        for i in 0..=k {
            probs[i] = 0.0;
        }
        for i in (k + 1)..=n {
            probs[i] = (1.0 - f) * probs[i] / pr_pk;
        }

        self.distribution.normalize();
    }

    /// Apply Bayesian update for a FAIL at position k (Equations 10-12).
    ///
    /// Pr[Fₖ | Cⱼ] = { f̂   if k < j    (can only fail before culprit due to flake)
    ///              { 1   otherwise  (always fails at or after culprit)
    fn apply_fail_update(&mut self, k: usize) {
        let n = self.num_suspects;
        let f = self.config.flake_rate;

        // Compute Pr[Fₖ] = Σⱼ₌₀ᵏ Pr[Cⱼ] + f̂ × Σⱼ₌ₖ₊₁ⁿ Pr[Cⱼ]
        let sum_before_or_at_k: f64 = (0..=k).map(|j| self.distribution.get(j)).sum();
        let sum_after_k: f64 = (k + 1..=n).map(|j| self.distribution.get(j)).sum();
        let pr_fk = sum_before_or_at_k + f * sum_after_k;

        if pr_fk <= 0.0 {
            return;
        }

        let probs = self.distribution.probs_mut();
        for i in 0..=k {
            // Pr[Cᵢ | Fₖ] = Pr[Cᵢ] / Pr[Fₖ]  (failure is expected here)
            probs[i] /= pr_fk;
        }
        for i in (k + 1)..=n {
            // Pr[Cᵢ | Fₖ] = f̂ × Pr[Cᵢ] / Pr[Fₖ]  (failure is only a flake here)
            probs[i] = f * probs[i] / pr_fk;
        }

        self.distribution.normalize();
    }

    /// Check if we've reached a conclusion.
    ///
    /// Returns `Some(result)` if the maximum probability exceeds the threshold,
    /// or `None` if the search should continue.
    pub fn result(&self) -> Option<SearchResult> {
        let confidence = self.distribution.max();
        if confidence >= self.config.threshold {
            let winner = self.distribution.argmax();
            if winner == self.num_suspects {
                Some(SearchResult::NoCulprit { confidence })
            } else {
                Some(SearchResult::Culprit {
                    position: winner,
                    confidence,
                })
            }
        } else {
            None
        }
    }

    /// Get the current probability distribution.
    pub fn distribution(&self) -> &Distribution {
        &self.distribution
    }

    /// Get all executions recorded so far.
    pub fn executions(&self) -> &[Execution] {
        &self.executions
    }

    /// Get iteration count (number of record_result calls).
    pub fn iterations(&self) -> usize {
        self.executions.len()
    }

    /// Get the number of suspects.
    pub fn num_suspects(&self) -> usize {
        self.num_suspects
    }

    /// Get the configuration.
    pub fn config(&self) -> &SearchConfig {
        &self.config
    }
}
