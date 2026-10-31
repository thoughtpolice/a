// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Binary-format mutators beyond radamsa: `wi`, `wa`, `lf` and `sz`.
//!
//! Binary formats store integers as fixed-width words in either byte order,
//! and many describe their own layout with counts and lengths. These
//! mutators edit such words directly. `wi` and `wa` follow AFL's
//! interesting-value and arithmetic stages, and `lf` guesses at length
//! fields. The integer mutators step their scores up on binary-looking data
//! and down on text, the reverse of the line mutators.

use crate::lines::binarish;
use crate::source::Source;

/// Integer widths in bytes, simplest first.
const WIDTHS: [usize; 4] = [1, 2, 4, 8];

/// Values that sit on common boundaries, from AFL's tables, extended to 64
/// bits. A value is written in two's complement and truncated to the
/// field's width, so -1 is the width's maximum.
const INTERESTING: [i64; 33] = [
    0,
    1,
    -1,
    16,
    32,
    64,
    100,
    127,
    -128,
    128,
    255,
    256,
    512,
    1000,
    1024,
    4096,
    32767,
    -32768,
    -129,
    65535,
    65536,
    -32769,
    32768,
    100_663_045,
    -100_663_046,
    i32::MAX as i64,
    i32::MIN as i64,
    u32::MAX as i64,
    1 << 32,
    -(1 << 32) - 1,
    1 << 53,
    i64::MAX,
    i64::MIN,
];

/// The largest step `wa` adds or subtracts, as in AFL.
const MAX_ARITH: usize = 35;

/// The largest power of two `sz` aims at: lengths up to 64 KiB + 1.
const MAX_SIZE_BITS: usize = 16;

/// Overwrites a 1, 2, 4 or 8 byte integer with an interesting value.
pub fn interesting<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    let Some((at, width, big)) = field(source, block.len()) else {
        return 0;
    };
    let value = INTERESTING[source.below(INTERESTING.len())] as u64;
    write(block, at, width, big, value);
    binary_step(block)
}

/// Adds or subtracts 1 to 35 from a 1, 2, 4 or 8 byte integer, wrapping.
pub fn arithmetic<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    let Some((at, width, big)) = field(source, block.len()) else {
        return 0;
    };
    let step = 1 + source.below(MAX_ARITH) as u64;
    let value = read(block, at, width, big);
    let value = if source.chance(1, 2) {
        value.wrapping_sub(step)
    } else {
        value.wrapping_add(step)
    };
    write(block, at, width, big, value);
    binary_step(block)
}

/// Finds a 1, 2 or 4 byte field whose value is the number of bytes after
/// it, after its start, or in the whole block, and makes it lie. A block
/// stands for its input here, so the guess is best for inputs that fit in
/// one block, which is any input up to 256 bytes.
pub fn length_field<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    let fields = length_fields(block);
    if fields.is_empty() {
        return -1;
    }
    let (at, width, big) = fields[source.below(fields.len())];
    let value = read(block, at, width, big);
    let max = mask(width);
    let lie = match source.below(6) {
        0 => 0,
        1 => value + 1,
        2 => value - 1,
        3 => value.wrapping_mul(2),
        4 => max,
        _ => max / 2 + 1,
    };
    write(block, at, width, big, lie);
    1
}

/// Truncates the block, or extends it by repeating its bytes, to a length
/// of 2^k - 1, 2^k or 2^k + 1 for some k from 1 to 16. Off-by-one errors
/// cluster at these sizes.
pub fn size_boundary<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let bits = 1 + source.below(MAX_SIZE_BITS);
    let target = (1 << bits) - 1 + source.below(3);
    let delta = source.delta();
    if target <= block.len() {
        block.truncate(target);
    } else if block.is_empty() {
        block.resize(target, 0);
    } else {
        let fill: Vec<u8> = block
            .iter()
            .copied()
            .cycle()
            .take(target - block.len())
            .collect();
        block.extend(fill);
    }
    delta
}

/// A field position, width and byte order that fits in `len` bytes.
fn field<S: Source>(source: &mut S, len: usize) -> Option<(usize, usize, bool)> {
    let width = WIDTHS[source.below(WIDTHS.len())];
    let at = source.below((len + 1).saturating_sub(width));
    let big = width > 1 && source.chance(1, 2);
    (len >= width).then_some((at, width, big))
}

/// Every plausible length field, narrow ones first.
fn length_fields(block: &[u8]) -> Vec<(usize, usize, bool)> {
    let len = block.len();
    let mut out = Vec::new();
    for width in [1, 2, 4] {
        for at in 0..(len + 1).saturating_sub(width) {
            for big in [false, true] {
                if width == 1 && big {
                    continue;
                }
                let value = read(block, at, width, big);
                // Small values match by accident too often to count.
                let lengths = [len - at - width, len - at, len];
                if value >= 2 && lengths.contains(&(value as usize)) {
                    out.push((at, width, big));
                }
            }
        }
    }
    out
}

fn mask(width: usize) -> u64 {
    if width == 8 {
        u64::MAX
    } else {
        (1 << (8 * width)) - 1
    }
}

fn read(block: &[u8], at: usize, width: usize, big: bool) -> u64 {
    let bytes = &block[at..at + width];
    let fold = |value: u64, &byte: &u8| value << 8 | u64::from(byte);
    if big {
        bytes.iter().fold(0, fold)
    } else {
        bytes.iter().rev().fold(0, fold)
    }
}

fn write(block: &mut [u8], at: usize, width: usize, big: bool, value: u64) {
    let bytes = value.to_le_bytes();
    let field = &mut block[at..at + width];
    field.copy_from_slice(&bytes[..width]);
    if big {
        field.reverse();
    }
}

fn binary_step(block: &[u8]) -> i8 {
    if binarish(block) { 1 } else { -1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn writes_interesting_values_in_either_order() {
        // Two bytes at 1, big-endian, the value 256.
        let mut block = vec![0; 4];
        assert_eq!(interesting(&mut Script::new(&[1, 1, 1, 11]), &mut block), 1);
        assert_eq!(block, [0, 1, 0, 0]);
        // One byte of -1 is 0xff, which makes text look binary.
        let mut text = b"abc".to_vec();
        assert_eq!(interesting(&mut Script::new(&[0, 2, 2]), &mut text), 1);
        assert_eq!(text, b"ab\xff");
        // A 1 keeps text looking like text, so the score falls.
        let mut plain = b"plain text".to_vec();
        assert_eq!(interesting(&mut Script::new(&[0, 0, 1]), &mut plain), -1);
        assert_eq!(plain, b"\x01lain text");
        // Too short for the width: no change.
        let mut short = vec![7];
        assert_eq!(interesting(&mut Script::new(&[3]), &mut short), 0);
        assert_eq!(short, [7]);
    }

    #[test]
    fn arithmetic_wraps_within_the_width() {
        // Two bytes at 0, little-endian, 255 + 5 = 260.
        let mut block = vec![0xff, 0x00, 0x80];
        arithmetic(&mut Script::new(&[1, 0, 0, 4, 0]), &mut block);
        assert_eq!(block, [0x04, 0x01, 0x80]);
        // One byte, 0 - 1 wraps to 0xff.
        let mut zero = vec![0];
        arithmetic(&mut Script::new(&[0, 0, 0, 1]), &mut zero);
        assert_eq!(zero, [0xff]);
    }

    #[test]
    fn finds_and_breaks_length_fields() {
        let packet = b"\x00\x05hello";
        assert_eq!(length_fields(packet), [(1, 1, false), (0, 2, true)]);
        let mut block = packet.to_vec();
        assert_eq!(length_field(&mut Script::new(&[1, 1]), &mut block), 1);
        assert_eq!(block, b"\x00\x06hello");
        let mut block = packet.to_vec();
        length_field(&mut Script::new(&[1, 4]), &mut block);
        assert_eq!(block, b"\xff\xffhello");
        assert_eq!(
            length_field(&mut Script::new(&[]), &mut b"no lengths".to_vec()),
            -1
        );
    }

    #[test]
    fn sizes_land_on_boundaries() {
        // k = 3, 2^3 - 1 + 1 = 8 bytes, by repeating.
        let mut block = b"abc".to_vec();
        size_boundary(&mut Script::new(&[2, 1]), &mut block);
        assert_eq!(block, b"abcabcab");
        let mut long = vec![9; 300];
        size_boundary(&mut Script::new(&[7, 2]), &mut long);
        assert_eq!(long.len(), 257);
        let mut empty = Vec::new();
        size_boundary(&mut Script::new(&[0, 0]), &mut empty);
        assert_eq!(empty, [0]);
    }

    #[test]
    fn integers_round_trip_through_both_orders() {
        let mut rng = crate::Rng::new(13);
        for _ in 0..1000 {
            let width = WIDTHS[rng.below(4)];
            let big = rng.below(2) == 1;
            let value = rng.next_u64() & mask(width);
            let mut block = vec![0; 8];
            write(&mut block, 0, width, big, value);
            assert_eq!(read(&block, 0, width, big), value);
        }
    }
}
