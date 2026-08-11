// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git packfile delta instruction parsing and application.
//!
//! Packfiles use delta compression to reduce size: instead of storing an
//! object's full content, a delta records how to reconstruct the object from
//! a "base" object using copy and insert instructions.
//!
//! # Delta buffer format
//!
//! ```text
//! ┌─────────────────────┬─────────────────────┬─────────────────────────┐
//! │ base_size (varint)  │ result_size (varint)│ instructions...         │
//! └─────────────────────┴─────────────────────┴─────────────────────────┘
//! ```
//!
//! The two varints encode the expected sizes of the base and result objects,
//! used for validation. Each varint byte contributes 7 data bits; bit 7 is
//! the continuation flag.
//!
//! # Instruction encoding
//!
//! Each instruction starts with a command byte:
//!
//! ## Copy (command byte bit 7 set, `0x80..=0xFF`)
//!
//! Copies a range from the base object into the result. The lower 7 bits of
//! the command byte are flags indicating which offset/size bytes follow:
//!
//! ```text
//! cmd: [1][sz2][sz1][sz0][off3][off2][off1][off0]
//!       │   └─────────┘     └────────────────┘
//!       │    size bytes        offset bytes
//!       └─ copy flag
//!
//! Bits 0-3 (off0..off3): if set, read 1 byte each for offset (little-endian)
//! Bits 4-6 (sz0..sz2):   if set, read 1 byte each for size (little-endian)
//! ```
//!
//! If no size bits are set, the copy size defaults to `0x10000` (64 KiB).
//!
//! ## Insert (command byte `0x01..=0x7F`)
//!
//! The command byte itself is the count of bytes to copy verbatim from the
//! delta stream into the result. Command byte `0x00` is reserved and invalid.
//!
//! # Example
//!
//! To produce `"hello!"` from base `"hello world"`:
//! ```text
//! base_size=11, result_size=6
//! COPY  offset=0, size=5   → "hello"
//! INSERT 1 byte: '!'       → "hello!"
//! ```

use crate::GitFetchError;

// ---------------------------------------------------------------------------------------------------------------
// Delta header parsing
// ---------------------------------------------------------------------------------------------------------------

/// Read a variable-length integer from a delta buffer.
///
/// Each byte contributes 7 bits; bit 7 is the continuation flag.
fn read_delta_varint(data: &[u8], offset: &mut usize) -> Result<usize, GitFetchError> {
    let mut value: usize = 0;
    let mut shift = 0;
    loop {
        if *offset >= data.len() {
            return Err(GitFetchError::InvalidPackfile(
                "truncated delta varint".into(),
            ));
        }
        // Reject before the shift amount exceeds the bit width (which would
        // panic); no valid object size needs this many bytes.
        if shift >= usize::BITS as usize {
            return Err(GitFetchError::InvalidPackfile(
                "delta varint too long".into(),
            ));
        }
        let byte = data[*offset];
        *offset += 1;
        value |= ((byte & 0x7f) as usize) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Ok(value)
}

// ---------------------------------------------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------------------------------------------

/// Apply a delta to a base object, producing a new object.
///
/// Parses the delta header (base size + result size varints), then executes
/// each copy/insert instruction sequentially. See the
/// [module-level docs](self) for the instruction encoding.
pub fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, GitFetchError> {
    let mut offset = 0;

    let base_size = read_delta_varint(delta, &mut offset)?;
    let result_size = read_delta_varint(delta, &mut offset)?;

    if base_size != base.len() {
        return Err(GitFetchError::InvalidPackfile(format!(
            "delta base size mismatch: header says {base_size}, actual is {}",
            base.len()
        )));
    }

    // The result size is attacker-controlled; bound it before allocating.
    if result_size > crate::MAX_GIT_OBJECT_SIZE {
        return Err(GitFetchError::InvalidPackfile(format!(
            "delta result size {result_size} exceeds limit {}",
            crate::MAX_GIT_OBJECT_SIZE
        )));
    }

    let mut result = Vec::with_capacity(result_size);

    while offset < delta.len() {
        let cmd = delta[offset];
        offset += 1;

        if cmd & 0x80 != 0 {
            // Copy instruction: copy from base
            let mut copy_offset: usize = 0;
            let mut copy_size: usize = 0;

            if cmd & 0x01 != 0 {
                check_bounds(delta, offset)?;
                copy_offset |= delta[offset] as usize;
                offset += 1;
            }
            if cmd & 0x02 != 0 {
                check_bounds(delta, offset)?;
                copy_offset |= (delta[offset] as usize) << 8;
                offset += 1;
            }
            if cmd & 0x04 != 0 {
                check_bounds(delta, offset)?;
                copy_offset |= (delta[offset] as usize) << 16;
                offset += 1;
            }
            if cmd & 0x08 != 0 {
                check_bounds(delta, offset)?;
                copy_offset |= (delta[offset] as usize) << 24;
                offset += 1;
            }
            if cmd & 0x10 != 0 {
                check_bounds(delta, offset)?;
                copy_size |= delta[offset] as usize;
                offset += 1;
            }
            if cmd & 0x20 != 0 {
                check_bounds(delta, offset)?;
                copy_size |= (delta[offset] as usize) << 8;
                offset += 1;
            }
            if cmd & 0x40 != 0 {
                check_bounds(delta, offset)?;
                copy_size |= (delta[offset] as usize) << 16;
                offset += 1;
            }

            // Size of 0 means 0x10000
            if copy_size == 0 {
                copy_size = 0x10000;
            }

            if copy_offset + copy_size > base.len() {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "delta copy out of bounds: offset={copy_offset}, size={copy_size}, base_len={}",
                    base.len()
                )));
            }

            result.extend_from_slice(&base[copy_offset..copy_offset + copy_size]);
        } else if cmd != 0 {
            // Insert instruction: copy next `cmd` bytes from delta
            let insert_size = cmd as usize;
            if offset + insert_size > delta.len() {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "delta insert truncated: need {insert_size} bytes at offset {offset}, have {}",
                    delta.len()
                )));
            }
            result.extend_from_slice(&delta[offset..offset + insert_size]);
            offset += insert_size;
        } else {
            return Err(GitFetchError::InvalidPackfile(
                "reserved delta instruction byte 0x00".into(),
            ));
        }
    }

    if result.len() != result_size {
        return Err(GitFetchError::InvalidPackfile(format!(
            "delta result size mismatch: expected {result_size}, got {}",
            result.len()
        )));
    }

    Ok(result)
}

fn check_bounds(data: &[u8], offset: usize) -> Result<(), GitFetchError> {
    if offset >= data.len() {
        return Err(GitFetchError::InvalidPackfile(
            "truncated delta copy instruction".into(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a delta buffer from given instructions.
    fn build_delta(base_size: usize, result_size: usize, instructions: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_varint(&mut buf, base_size);
        encode_varint(&mut buf, result_size);
        buf.extend_from_slice(instructions);
        buf
    }

    fn encode_varint(buf: &mut Vec<u8>, mut value: usize) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            buf.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    #[test]
    fn insert_only_delta() {
        // Insert 5 bytes: "world"
        let base = b"hello";
        let instructions = [5u8, b'w', b'o', b'r', b'l', b'd'];
        let delta = build_delta(5, 5, &instructions);
        let result = apply_delta(base, &delta).unwrap();
        assert_eq!(result, b"world");
    }

    #[test]
    fn copy_only_delta() {
        // Copy entire base: offset=0, size=5
        // cmd = 0x80 | 0x01 (offset byte) | 0x10 (size byte) = 0x91
        let base = b"hello";
        let instructions = [0x91u8, 0x00, 0x05];
        let delta = build_delta(5, 5, &instructions);
        let result = apply_delta(base, &delta).unwrap();
        assert_eq!(result, b"hello");
    }

    #[test]
    fn copy_partial() {
        // Copy 3 bytes from offset 1: "ell"
        // cmd = 0x80 | 0x01 (offset) | 0x10 (size) = 0x91
        let base = b"hello";
        let instructions = [0x91u8, 0x01, 0x03];
        let delta = build_delta(5, 3, &instructions);
        let result = apply_delta(base, &delta).unwrap();
        assert_eq!(result, b"ell");
    }

    #[test]
    fn mixed_copy_and_insert() {
        // Base: "hello"
        // Result: "hello world" (11 bytes)
        // Instructions: copy 5 from base + insert 6 " world"
        let base = b"hello";
        let mut instructions = Vec::new();
        // Copy all 5: cmd=0x91, offset=0, size=5
        instructions.extend_from_slice(&[0x91, 0x00, 0x05]);
        // Insert 6: " world"
        instructions.push(6);
        instructions.extend_from_slice(b" world");

        let delta = build_delta(5, 11, &instructions);
        let result = apply_delta(base, &delta).unwrap();
        assert_eq!(result, b"hello world");
    }

    #[test]
    fn copy_with_zero_size_means_65536() {
        // A copy with size=0 means 0x10000 (65536) bytes
        let base = vec![0xAB; 0x10000];
        // cmd = 0x80 | 0x01 (offset byte) = 0x81, offset=0, no size bytes => size=0x10000
        let instructions = [0x81u8, 0x00];
        let delta = build_delta(0x10000, 0x10000, &instructions);
        let result = apply_delta(&base, &delta).unwrap();
        assert_eq!(result.len(), 0x10000);
        assert!(result.iter().all(|&b| b == 0xAB));
    }

    #[test]
    fn copy_with_multi_byte_offset() {
        // Base: 300 bytes; copy 5 bytes from offset 256
        let mut base = vec![0u8; 300];
        base[256..261].copy_from_slice(b"FOUND");

        // cmd = 0x80 | 0x01 | 0x02 (2 offset bytes) | 0x10 (1 size byte) = 0x93
        // offset = 0x0100 = 256 (little-endian: 0x00, 0x01)
        // size = 5
        let instructions = [0x93u8, 0x00, 0x01, 0x05];
        let delta = build_delta(300, 5, &instructions);
        let result = apply_delta(&base, &delta).unwrap();
        assert_eq!(result, b"FOUND");
    }

    #[test]
    fn base_size_mismatch_errors() {
        let base = b"hi";
        let delta = build_delta(10, 2, &[2, b'h', b'i']);
        assert!(apply_delta(base, &delta).is_err());
    }

    #[test]
    fn result_size_mismatch_errors() {
        let base = b"hello";
        // Claim result is 10 but only insert 5
        let delta = build_delta(5, 10, &[5, b'w', b'o', b'r', b'l', b'd']);
        assert!(apply_delta(base, &delta).is_err());
    }

    #[test]
    fn copy_out_of_bounds_errors() {
        let base = b"hi";
        // Try to copy from offset 10
        let instructions = [0x91u8, 0x0a, 0x01];
        let delta = build_delta(2, 1, &instructions);
        assert!(apply_delta(base, &delta).is_err());
    }

    #[test]
    fn reserved_byte_zero_errors() {
        let base = b"hi";
        let delta = build_delta(2, 0, &[0x00]);
        assert!(apply_delta(base, &delta).is_err());
    }

    #[test]
    fn empty_delta_on_empty_base() {
        let base = b"";
        let delta = build_delta(0, 0, &[]);
        let result = apply_delta(base, &delta).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn overlong_varint_errors() {
        // Continuation bit set on every byte — the shift would exceed the
        // bit width. Must error, not panic.
        let delta = [0xFFu8; 16];
        let base = b"hi";
        assert!(apply_delta(base, &delta).is_err());
    }

    #[test]
    fn huge_result_size_errors_before_allocating() {
        // base_size matches, result_size is absurd (usize::MAX encoding).
        let mut delta = Vec::new();
        encode_varint(&mut delta, 2);
        encode_varint(&mut delta, usize::MAX);
        delta.push(2);
        delta.extend_from_slice(b"hi");
        assert!(apply_delta(b"hi", &delta).is_err());
    }

    #[test]
    fn varint_encoding() {
        // Test that varint encodes/decodes correctly for various values
        for &val in &[0, 1, 127, 128, 255, 256, 16383, 16384, 65535, 1_000_000] {
            let mut buf = Vec::new();
            encode_varint(&mut buf, val);
            let mut offset = 0;
            let decoded = read_delta_varint(&buf, &mut offset).unwrap();
            assert_eq!(decoded, val, "failed for value {val}");
            assert_eq!(offset, buf.len());
        }
    }
}
