// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Line diffs, for the gutter's marks: the hunks where a buffer's lines
//! differ from a version of its file.
//!
//! Lines are compared by hash ([`hash_line`]), so a diff never needs either
//! text as one string. The diff is Myers's, in linear space (the middle
//! snake, divide and conquer), after the lines both ends share are trimmed.
//! Its work is bounded: a stretch that would take more is one hunk, as a
//! rewrite of the whole of a huge file deserves.

/// Where the old lines `old_start..old_start + old_len` became the new
/// lines `new_start..new_start + new_len`. Either length may be zero: lines
/// added, or lines deleted (before new line `new_start`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
}

/// A line's hash, from its text in pieces (a rope's chunks, say): FNV-1a,
/// which takes the pieces as a stream, so any split of a line hashes alike.
pub fn hash_line<'a>(pieces: impl IntoIterator<Item = &'a str>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for piece in pieces {
        for &b in piece.as_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// The hashes of the lines of `s`, split at "\n" (which no line includes):
/// a text ending in a newline has an empty last line, as a rope does.
pub fn hash_lines(s: &str) -> Vec<u64> {
    s.split('\n').map(|l| hash_line([l])).collect()
}

/// How many steps of the search a diff may take before it settles for a
/// coarser answer.
const BUDGET: usize = 20_000_000;

/// The hunks that turn `old` into `new`, in order, apart.
pub fn diff(old: &[u64], new: &[u64]) -> Vec<Hunk> {
    let mut d = Differ {
        old,
        new,
        vf: Vec::new(),
        vb: Vec::new(),
        budget: BUDGET,
        hunks: Vec::new(),
    };
    d.conquer(0, old.len(), 0, new.len());
    d.hunks
}

struct Differ<'a> {
    old: &'a [u64],
    new: &'a [u64],
    vf: Vec<isize>,
    vb: Vec<isize>,
    budget: usize,
    hunks: Vec<Hunk>,
}

impl Differ<'_> {
    /// Old lines o0..o1 against new lines n0..n1, in order.
    fn conquer(&mut self, mut o0: usize, mut o1: usize, mut n0: usize, mut n1: usize) {
        while o0 < o1 && n0 < n1 && self.old[o0] == self.new[n0] {
            o0 += 1;
            n0 += 1;
        }
        while o0 < o1 && n0 < n1 && self.old[o1 - 1] == self.new[n1 - 1] {
            o1 -= 1;
            n1 -= 1;
        }
        if o0 == o1 || n0 == n1 {
            self.change(o0, o1, n0, n1);
        } else if let Some((x, y)) = self.middle_snake(o0, o1, n0, n1) {
            self.conquer(o0, x, n0, y);
            self.conquer(x, o1, y, n1);
        } else {
            self.change(o0, o1, n0, n1);
        }
    }

    /// Old lines o0..o1 became new lines n0..n1: a hunk, or more of the one
    /// it follows straight on from.
    fn change(&mut self, o0: usize, o1: usize, n0: usize, n1: usize) {
        if o0 == o1 && n0 == n1 {
            return;
        }
        if let Some(last) = self.hunks.last_mut()
            && last.old_start + last.old_len == o0
            && last.new_start + last.new_len == n0
        {
            last.old_len += o1 - o0;
            last.new_len += n1 - n0;
            return;
        }
        self.hunks.push(Hunk {
            old_start: o0,
            old_len: o1 - o0,
            new_start: n0,
            new_len: n1 - n0,
        });
    }

    /// Where an edit path of the fewest edits from (o0, n0) to (o1, n1)
    /// can be split in two: a point on it about halfway, each half then
    /// diffed on its own. None if the budget runs out first.
    fn middle_snake(
        &mut self,
        o0: usize,
        o1: usize,
        n0: usize,
        n1: usize,
    ) -> Option<(usize, usize)> {
        let n = (o1 - o0) as isize;
        let m = (n1 - n0) as isize;
        let delta = n - m;
        let odd = delta & 1 == 1;
        let d_max = (n + m + 1) / 2 + 1;
        // Diagonals k from -d_max - 1 to d_max + 1, at k + offset.
        let offset = d_max + 1;
        let size = (2 * offset + 1) as usize;
        self.vf.clear();
        self.vf.resize(size, 0);
        self.vb.clear();
        self.vb.resize(size, 0);
        let (old, new) = (self.old, self.new);
        let same_forward = |x: isize, y: isize| old[o0 + x as usize] == new[n0 + y as usize];
        let same_backward =
            |x: isize, y: isize| old[o1 - 1 - x as usize] == new[n1 - 1 - y as usize];
        let at = |k: isize| (k + offset) as usize;
        for d in 0..d_max {
            self.budget = self.budget.checked_sub(2 * d as usize + 1)?;
            // Forward, from the start: vf[k] is the furthest x reached on
            // diagonal k (x - y = k) in d edits.
            let mut k = -d;
            while k <= d {
                let mut x = if k == -d || (k != d && self.vf[at(k - 1)] < self.vf[at(k + 1)]) {
                    self.vf[at(k + 1)]
                } else {
                    self.vf[at(k - 1)] + 1
                };
                let mut y = x - k;
                let (x0, y0) = (x, y);
                while x < n && y < m && same_forward(x, y) {
                    x += 1;
                    y += 1;
                }
                self.vf[at(k)] = x;
                // The backward search's diagonal is delta - k.
                if odd && (k - delta).abs() < d && self.vf[at(k)] + self.vb[at(delta - k)] >= n {
                    return Some((o0 + x0 as usize, n0 + y0 as usize));
                }
                k += 2;
            }
            // Backward, from the end: vb[k] is how far back x has come.
            let mut k = -d;
            while k <= d {
                let mut x = if k == -d || (k != d && self.vb[at(k - 1)] < self.vb[at(k + 1)]) {
                    self.vb[at(k + 1)]
                } else {
                    self.vb[at(k - 1)] + 1
                };
                let mut y = x - k;
                while x < n && y < m && same_backward(x, y) {
                    x += 1;
                    y += 1;
                }
                self.vb[at(k)] = x;
                if !odd && (k - delta).abs() <= d && self.vb[at(k)] + self.vf[at(delta - k)] >= n {
                    return Some((o0 + (n - x) as usize, n0 + (m - y) as usize));
                }
                k += 2;
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<u64> {
        hash_lines(s)
    }

    /// new's lines, made from old's and the hunks: they must be new's.
    fn patch(old: &[u64], new: &[u64], hunks: &[Hunk]) -> Vec<u64> {
        let mut out = Vec::new();
        let mut o = 0;
        for h in hunks {
            out.extend_from_slice(&old[o..h.old_start]);
            out.extend_from_slice(&new[h.new_start..h.new_start + h.new_len]);
            o = h.old_start + h.old_len;
        }
        out.extend_from_slice(&old[o..]);
        out
    }

    #[test]
    fn small() {
        assert_eq!(diff(&lines("a\nb\nc"), &lines("a\nb\nc")), vec![]);
        assert_eq!(
            diff(&lines("a\nb\nc"), &lines("a\nx\nc")),
            vec![Hunk {
                old_start: 1,
                old_len: 1,
                new_start: 1,
                new_len: 1
            }]
        );
        assert_eq!(
            diff(&lines("a\nc"), &lines("a\nb\nc")),
            vec![Hunk {
                old_start: 1,
                old_len: 0,
                new_start: 1,
                new_len: 1
            }]
        );
        assert_eq!(
            diff(&lines("a\nb\nc"), &lines("a\nc")),
            vec![Hunk {
                old_start: 1,
                old_len: 1,
                new_start: 1,
                new_len: 0
            }]
        );
        // Two changes apart stay two hunks.
        assert_eq!(
            diff(&lines("a\nb\nc\nd\ne"), &lines("x\nb\nc\nd\ny")).len(),
            2
        );
    }

    #[test]
    fn split_lines_hash_alike() {
        assert_eq!(hash_line(["ab", "c"]), hash_line(["abc"]));
        assert_eq!(hash_line(["", "abc", ""]), hash_line(["abc"]));
    }

    /// The fewest lines changed, by the textbook dynamic program.
    fn fewest(a: &[u64], b: &[u64]) -> usize {
        let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
        for i in (0..a.len()).rev() {
            for j in (0..b.len()).rev() {
                lcs[i][j] = if a[i] == b[j] {
                    lcs[i + 1][j + 1] + 1
                } else {
                    lcs[i + 1][j].max(lcs[i][j + 1])
                };
            }
        }
        a.len() + b.len() - 2 * lcs[0][0]
    }

    /// Up to 40 lines, of few kinds, so that two have much in common.
    fn some_lines(tc: &hegel::TestCase) -> Vec<u64> {
        use hegel::generators as gs;
        (0..tc.draw(gs::integers::<usize>().max_value(40)))
            .map(|_| tc.draw(gs::integers::<u64>().max_value(4)))
            .collect()
    }

    #[hegel::test(test_cases = 300, database = None)]
    fn diffs_patch_and_are_minimal(tc: hegel::TestCase) {
        let old = some_lines(&tc);
        let new = some_lines(&tc);
        let hunks = diff(&old, &new);
        assert_eq!(patch(&old, &new, &hunks), new);
        // In order and apart, none empty.
        for w in hunks.windows(2) {
            assert!(
                w[0].old_start + w[0].old_len < w[1].old_start
                    || w[0].new_start + w[0].new_len < w[1].new_start
            );
        }
        assert!(hunks.iter().all(|h| h.old_len + h.new_len > 0));
        let changed: usize = hunks.iter().map(|h| h.old_len + h.new_len).sum();
        assert_eq!(changed, fewest(&old, &new));
    }

    #[test]
    fn a_huge_rewrite_is_one_hunk_soon() {
        let old: Vec<u64> = (0..200_000).collect();
        let new: Vec<u64> = (1_000_000..1_200_000).collect();
        let t = std::time::Instant::now();
        let hunks = diff(&old, &new);
        assert_eq!(patch(&old, &new, &hunks), new);
        assert!(t.elapsed().as_secs() < 10);
    }
}
