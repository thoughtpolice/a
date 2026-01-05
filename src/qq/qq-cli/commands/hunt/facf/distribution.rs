// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/// The probability distribution over suspects + "no culprit".
///
/// For `n` suspects, the distribution has length `n+1`:
/// - `probs[0..n]` = probability each suspect is the culprit
/// - `probs[n]` = probability there is no culprit (original failure was a flake)
#[derive(Debug, Clone)]
pub struct Distribution {
    probs: Vec<f64>,
}

impl Distribution {
    /// Create a uniform prior distribution for `n` suspects.
    ///
    /// Each suspect (and "no culprit") gets probability `1/(n+1)`.
    pub fn uniform(num_suspects: usize) -> Self {
        let prob = 1.0 / (num_suspects + 1) as f64;
        Self {
            probs: vec![prob; num_suspects + 1],
        }
    }

    /// Create a distribution from raw probabilities.
    ///
    /// The probabilities should sum to 1.0 (within tolerance).
    pub fn from_probs(probs: Vec<f64>) -> Self {
        assert!(probs.len() >= 2, "need at least 1 suspect + no-culprit");
        assert!(
            probs.iter().all(|&p| p >= 0.0),
            "all probabilities must be non-negative"
        );
        Self { probs }
    }

    /// Get probability for suspect `i` (or no-culprit if `i == num_suspects`).
    pub fn get(&self, i: usize) -> f64 {
        self.probs[i]
    }

    /// Get index with maximum probability.
    pub fn argmax(&self) -> usize {
        self.probs
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(i, _)| i)
            .unwrap_or(0)
    }

    /// Get maximum probability value.
    pub fn max(&self) -> f64 {
        self.probs.iter().cloned().fold(0.0, f64::max)
    }

    /// Compute cumulative distribution function.
    ///
    /// Returns a vector where `cdf[i]` = sum of `probs[0..=i]`.
    pub fn cdf(&self) -> Vec<f64> {
        let mut cdf = Vec::with_capacity(self.probs.len());
        let mut cumsum = 0.0;
        for &p in &self.probs {
            cumsum += p;
            cdf.push(cumsum);
        }
        cdf
    }

    /// Number of suspects (excludes no-culprit slot).
    pub fn num_suspects(&self) -> usize {
        self.probs.len() - 1
    }

    /// Get the raw probability vector.
    pub fn probs(&self) -> &[f64] {
        &self.probs
    }

    /// Get a mutable reference to the raw probability vector.
    pub fn probs_mut(&mut self) -> &mut [f64] {
        &mut self.probs
    }

    /// Check if probabilities sum to 1.0 (within tolerance).
    pub fn is_normalized(&self) -> bool {
        let sum: f64 = self.probs.iter().sum();
        (sum - 1.0).abs() < 1e-9
    }

    /// Normalize the distribution so probabilities sum to 1.0.
    pub fn normalize(&mut self) {
        let sum: f64 = self.probs.iter().sum();
        if sum > 0.0 {
            for p in &mut self.probs {
                *p /= sum;
            }
        }
    }
}
