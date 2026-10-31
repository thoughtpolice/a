// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Line mutators, radamsa's `ld`, `lds`, `lr2`, `li`, `lr`, `ls`, `lp`,
//! `lis` and `lrs`.
//!
//! A line mutator treats a block as lines when its first line does not look
//! binary. A line keeps its trailing newline, so the operations move whole
//! lines and the block reassembles by concatenation. A line mutator steps
//! its score up whenever the block splits into lines and down when it does
//! not.

use crate::list::{clone_elsewhere, delete, delete_run, duplicate, permute, repeat, swap};
use crate::source::Source;

/// How many lines `lis` and `lrs` remember between calls.
const STORED_LINES: usize = 10;

/// Which list operation a line mutator applies.
#[derive(Clone, Copy, Debug)]
pub enum LineOp {
    Delete,
    DeleteRun,
    Duplicate,
    Clone,
    Repeat,
    Swap,
    Permute,
}

/// Applies `op` to the lines of `block`.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>, op: LineOp) -> i8 {
    let Some(mut lines) = split(block) else {
        return -1;
    };
    match op {
        LineOp::Delete => delete(source, &mut lines),
        LineOp::DeleteRun => delete_run(source, &mut lines),
        LineOp::Duplicate => duplicate(source, &mut lines),
        LineOp::Clone => clone_elsewhere(source, &mut lines),
        LineOp::Repeat => repeat(source, &mut lines),
        LineOp::Swap => swap(source, &mut lines),
        LineOp::Permute => permute(source, &mut lines),
    }
    *block = lines.concat();
    1
}

/// Lines seen in earlier blocks, so `lis` and `lrs` can carry a line from
/// one input into another.
#[derive(Clone, Debug, Default)]
pub struct LineStore(Vec<Vec<u8>>);

impl LineStore {
    /// Inserts a remembered line before a random line.
    pub fn insert<S: Source>(&mut self, source: &mut S, block: &mut Vec<u8>) -> i8 {
        self.edit(source, block, |lines, at, line| lines.insert(at, line))
    }

    /// Replaces a random line with a remembered one.
    pub fn replace<S: Source>(&mut self, source: &mut S, block: &mut Vec<u8>) -> i8 {
        self.edit(source, block, |lines, at, line| lines[at] = line)
    }

    fn edit<S: Source>(
        &mut self,
        source: &mut S,
        block: &mut Vec<u8>,
        apply: impl FnOnce(&mut Vec<Vec<u8>>, usize, Vec<u8>),
    ) -> i8 {
        let Some(mut lines) = split(block) else {
            return -1;
        };
        self.remember(source, &lines);
        let line = self.0[source.below(self.0.len())].clone();
        let at = source.below(lines.len());
        apply(&mut lines, at, line);
        *block = lines.concat();
        1
    }

    /// Fills the store from `lines`, then with probability 1/2 swaps one of
    /// the ten stored lines for a fresh one.
    fn remember<S: Source>(&mut self, source: &mut S, lines: &[Vec<u8>]) {
        while self.0.len() < STORED_LINES {
            self.0.push(lines[source.below(lines.len())].clone());
        }
        let slot = source.below(2 * STORED_LINES);
        if slot < STORED_LINES {
            self.0[slot] = lines[source.below(lines.len())].clone();
        }
    }
}

/// Splits `block` after each newline, or returns `None` when there is no
/// data or the first line looks binary.
fn split(block: &[u8]) -> Option<Vec<Vec<u8>>> {
    let lines: Vec<Vec<u8>> = block
        .split_inclusive(|&byte| byte == b'\n')
        .map(<[u8]>::to_vec)
        .collect();
    match lines.first() {
        Some(first) if !binarish(first) => Some(lines),
        _ => None,
    }
}

/// Whether data looks binary, meaning a NUL or a byte with the high bit set
/// among its first eight bytes. UTF-8 text counts as binary, as in radamsa.
pub fn binarish(data: &[u8]) -> bool {
    data.iter()
        .take(8)
        .any(|&byte| byte == 0 || byte & 0x80 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn lines(draws: &[usize], input: &[u8], op: LineOp) -> (i8, Vec<u8>) {
        let mut block = input.to_vec();
        let delta = mutate(&mut Script::new(draws), &mut block, op);
        (delta, block)
    }

    #[test]
    fn line_operations_move_whole_lines() {
        let text = b"a\nb\nc";
        assert_eq!(lines(&[1], text, LineOp::Delete).1, b"a\nc");
        assert_eq!(lines(&[0, 2], text, LineOp::DeleteRun).1, b"c");
        assert_eq!(lines(&[2], text, LineOp::Duplicate).1, b"a\nb\ncc");
        assert_eq!(lines(&[2, 0], text, LineOp::Clone).1, b"ca\nb\nc");
        assert_eq!(lines(&[1, 2, 0], text, LineOp::Repeat).1, b"a\nb\nb\nb\nc");
        assert_eq!(lines(&[0], text, LineOp::Swap).1, b"b\na\nc");
    }

    #[test]
    fn binary_blocks_are_refused() {
        assert_eq!(
            lines(&[], b"\x89PNG\r\n", LineOp::Delete),
            (-1, b"\x89PNG\r\n".to_vec())
        );
        assert_eq!(lines(&[], b"", LineOp::Delete), (-1, Vec::new()));
        // Only the first line is checked.
        assert_eq!(
            lines(&[1], b"ok\n\xff\n", LineOp::Delete),
            (1, b"ok\n".to_vec())
        );
    }

    #[test]
    fn stored_lines_cross_blocks() {
        let mut store = LineStore::default();
        let mut first = b"keep\n".to_vec();
        // Fill all ten slots with "keep\n", leave them, pick slot 0, insert at 0.
        let mut source = Script::new(&[0; 10]);
        source.0.push_back(10);
        assert_eq!(store.insert(&mut source, &mut first), 1);
        assert_eq!(first, b"keep\nkeep\n");

        let mut second = b"x\ny\n".to_vec();
        assert_eq!(store.replace(&mut Script::new(&[19, 0, 1]), &mut second), 1);
        assert_eq!(second, b"x\nkeep\n");
    }
}
