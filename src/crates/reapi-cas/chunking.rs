// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Content-defined chunking with FastCDC 2020, as REAPI's
//! `FastCdc2020Params` specify it: normalization level 2, and minimum and
//! maximum chunk sizes derived from the average (a quarter, and four times).
//! Clients and servers that share these parameters cut the same blob into
//! the same chunks, which is what lets SplitBlob and SpliceBlob reuse them.

/// FastCDC 2020 parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FastCdc2020 {
    pub min_size: usize,
    pub avg_size: usize,
    pub max_size: usize,
    /// XORed into the gear table. Everyone sharing a cache should use the
    /// same seed, or they share no chunks.
    pub seed: u64,
}

impl FastCdc2020 {
    /// The average REAPI recommends: 512 KiB.
    pub const RECOMMENDED_AVG_SIZE: usize = 512 * 1024;

    /// REAPI's recommended parameters: a 512 KiB average and seed 0.
    pub const RECOMMENDED: Self = Self::from_average(Self::RECOMMENDED_AVG_SIZE, 0);

    /// The parameters REAPI derives from an average chunk size (which it
    /// requires to be between 1 KiB and 1 MiB) and a seed.
    pub const fn from_average(avg_size: usize, seed: u64) -> Self {
        Self {
            min_size: avg_size / 4,
            avg_size,
            max_size: avg_size * 4,
            seed,
        }
    }

    /// The chunks `data` is cut into, as `(offset, length)`, in order and
    /// covering all of it.
    ///
    /// REAPI asks clients to upload blobs smaller than
    /// [`max_size`](Self::max_size) without chunking them; this cuts
    /// whatever it is given.
    pub fn ranges<'a>(&self, data: &'a [u8]) -> impl Iterator<Item = (usize, usize)> + 'a {
        fastcdc::v2020::FastCDC::with_level_and_seed(
            data,
            self.min_size,
            self.avg_size,
            self.max_size,
            fastcdc::v2020::Normalization::Level2,
            self.seed,
        )
        .map(|chunk| (chunk.offset, chunk.length))
    }
}

impl Default for FastCdc2020 {
    fn default() -> Self {
        Self::RECOMMENDED
    }
}
