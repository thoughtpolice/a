// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! List operations shared by the byte and line mutators, ported from
//! radamsa's generic list mutations. Each draws its positions from the
//! source and leaves lists too short for it unchanged.

use crate::source::Source;

/// Removes one element.
pub fn delete<S: Source, T>(source: &mut S, items: &mut Vec<T>) {
    if !items.is_empty() {
        items.remove(source.below(items.len()));
    }
}

/// Removes a run of elements, possibly empty, from a random start.
pub fn delete_run<S: Source, T>(source: &mut S, items: &mut Vec<T>) {
    if items.is_empty() {
        return;
    }
    let start = source.below(items.len());
    let len = source.below(items.len() - start);
    items.drain(start..start + len);
}

/// Duplicates one element in place.
pub fn duplicate<S: Source, T: Clone>(source: &mut S, items: &mut Vec<T>) {
    if !items.is_empty() {
        let at = source.below(items.len());
        items.insert(at, items[at].clone());
    }
}

/// Copies one element to another position.
pub fn clone_elsewhere<S: Source, T: Clone>(source: &mut S, items: &mut Vec<T>) {
    if !items.is_empty() {
        let from = source.below(items.len());
        let to = source.below(items.len());
        items.insert(to, items[from].clone());
    }
}

/// Repeats one element 2 to 1023 extra times.
pub fn repeat<S: Source, T: Clone>(source: &mut S, items: &mut Vec<T>) {
    if !items.is_empty() {
        let at = source.below(items.len());
        let count = source.log(10).max(2);
        let item = items[at].clone();
        items.splice(at..at, std::iter::repeat_n(item, count));
    }
}

/// Swaps two adjacent elements.
pub fn swap<S: Source, T>(source: &mut S, items: &mut [T]) {
    if items.len() >= 2 {
        let at = source.below(items.len() - 1);
        items.swap(at, at + 1);
    }
}

/// Permutes a run of at least two elements, log-scaled in length.
pub fn permute<S: Source, T>(source: &mut S, items: &mut [T]) {
    let len = items.len();
    if len < 3 {
        return;
    }
    let from = source.below(len - 3);
    let room = source.range(2, len - from);
    let wanted = source.log(10);
    let run = room.min(wanted).max(2);
    source.shuffle(&mut items[from..from + run]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn permute_keeps_every_element() {
        let mut rng = crate::Rng::new(9);
        for len in 0..12 {
            let mut items: Vec<usize> = (0..len).collect();
            permute(&mut rng, &mut items);
            items.sort();
            assert_eq!(items, (0..len).collect::<Vec<_>>());
        }
    }

    #[test]
    fn short_lists_are_left_alone() {
        let mut empty: Vec<u8> = Vec::new();
        let mut zeros = Script::new(&[]);
        delete(&mut zeros, &mut empty);
        delete_run(&mut zeros, &mut empty);
        duplicate(&mut zeros, &mut empty);
        clone_elsewhere(&mut zeros, &mut empty);
        repeat(&mut zeros, &mut empty);
        assert!(empty.is_empty());
        let mut one = [1];
        swap(&mut zeros, &mut one);
        permute(&mut zeros, &mut one);
        assert_eq!(one, [1]);
    }
}
