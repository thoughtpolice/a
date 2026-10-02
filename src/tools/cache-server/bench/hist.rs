// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A log-linear latency histogram: 64 buckets per power of two, so any
//! recorded value is reported within 1.6% of itself, from nanoseconds to
//! centuries, in a fixed 30 KiB.

const SUB_BITS: u32 = 6;
const SUB: u64 = 1 << SUB_BITS;
const BUCKETS: usize = ((64 - SUB_BITS as usize) + 1) * SUB as usize;

#[derive(Clone)]
pub struct Histogram {
    counts: Box<[u64; BUCKETS]>,
    total: u64,
    sum: u128,
    min: u64,
    max: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            counts: Box::new([0; BUCKETS]),
            total: 0,
            sum: 0,
            min: u64::MAX,
            max: 0,
        }
    }
}

fn index(v: u64) -> usize {
    if v < SUB {
        return v as usize;
    }
    let msb = 63 - v.leading_zeros();
    let shift = msb - SUB_BITS;
    // `v >> shift` lies in [SUB, 2 * SUB).
    ((u64::from(shift) + 1) * SUB + ((v >> shift) - SUB)) as usize
}

/// The largest value that lands in bucket `i`.
fn upper_bound(i: usize) -> u64 {
    let i = i as u64;
    if i < SUB {
        return i;
    }
    let shift = i / SUB - 1;
    let sub = i % SUB;
    ((SUB + sub + 1) << shift).saturating_sub(1)
}

impl Histogram {
    pub fn record(&mut self, v: u64) {
        self.counts[index(v)] += 1;
        self.total += 1;
        self.sum += u128::from(v);
        self.min = self.min.min(v);
        self.max = self.max.max(v);
    }

    pub fn merge(&mut self, other: &Histogram) {
        for (a, b) in self.counts.iter_mut().zip(other.counts.iter()) {
            *a += b;
        }
        self.total += other.total;
        self.sum += other.sum;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }

    pub fn count(&self) -> u64 {
        self.total
    }

    pub fn mean(&self) -> u64 {
        if self.total == 0 {
            0
        } else {
            (self.sum / u128::from(self.total)) as u64
        }
    }

    pub fn max(&self) -> u64 {
        self.max
    }

    /// The value at quantile `q` (0..=1), as its bucket's upper bound,
    /// clamped to the largest value recorded.
    pub fn quantile(&self, q: f64) -> u64 {
        if self.total == 0 {
            return 0;
        }
        let target = ((q * self.total as f64).ceil() as u64).clamp(1, self.total);
        let mut seen = 0;
        for (i, &c) in self.counts.iter().enumerate() {
            seen += c;
            if seen >= target {
                return upper_bound(i).min(self.max).max(self.min);
            }
        }
        self.max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_contiguous_and_tight() {
        let mut prev = None;
        for i in 0..BUCKETS - 1 {
            let hi = upper_bound(i);
            if let Some(p) = prev {
                assert_eq!(hi > p, true, "bucket {i} does not grow");
            }
            assert_eq!(index(hi), i, "upper bound of {i} lands elsewhere");
            assert_eq!(index(hi + 1), i + 1, "{} skips a bucket", hi + 1);
            prev = Some(hi);
        }
        assert_eq!(index(u64::MAX), BUCKETS - 1);
    }

    #[test]
    fn quantiles_are_within_two_percent() {
        let mut h = Histogram::default();
        for v in 1..=100_000u64 {
            h.record(v * 1000);
        }
        for q in [0.5, 0.9, 0.99, 0.999] {
            let exact = (q * 100_000.0) as u64 * 1000;
            let got = h.quantile(q);
            let err = (got as f64 - exact as f64).abs() / exact as f64;
            assert!(err < 0.02, "q{q}: {got} vs {exact}");
        }
        assert_eq!(h.quantile(1.0), 100_000_000);
        assert_eq!(h.count(), 100_000);
    }
}
