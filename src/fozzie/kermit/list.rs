// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! List operations for the mutators, ported from radamsa's generic list
//! mutations. Each draws its positions from the source and leaves lists too
//! short for it unchanged.

use crate::source::Source;

/// Removes a run of elements, possibly empty, from a random start.
pub fn delete_run<S: Source, T>(source: &mut S, items: &mut Vec<T>) {
    if items.is_empty() {
        return;
    }
    let start = source.below(items.len());
    let len = source.below(items.len() - start);
    items.drain(start..start + len);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn short_lists_are_left_alone() {
        let mut empty: Vec<u8> = Vec::new();
        delete_run(&mut Script::new(&[]), &mut empty);
        assert!(empty.is_empty());
    }
}
