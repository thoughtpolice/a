// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Synthetic packfile construction for tests.
//!
//! Builds syntactically valid packfiles — real object headers, delta
//! encodings, offsets, and SHA-1 trailer — without needing a git binary or
//! network access. Used by this crate's tests and by downstream crates
//! (e.g. the cache-server's git ingestion tests).
//!
//! Not a stable API: test support only.

use flate2::Compression;
use flate2::write::ZlibEncoder;
use sha1::{Digest as _, Sha1};
use std::io::Write as _;

use crate::objects::{GitObjectType, git_sha1};

fn zlib_compress(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn encode_object_header(buf: &mut Vec<u8>, type_bits: u8, size: usize) {
    let mut first_byte = (type_bits << 4) | ((size & 0x0f) as u8);
    let mut remaining = size >> 4;
    if remaining > 0 {
        first_byte |= 0x80;
    }
    buf.push(first_byte);
    while remaining > 0 {
        let mut byte = (remaining & 0x7f) as u8;
        remaining >>= 7;
        if remaining > 0 {
            byte |= 0x80;
        }
        buf.push(byte);
    }
}

fn encode_ofs_offset(buf: &mut Vec<u8>, mut value: usize) {
    let mut bytes = vec![(value & 0x7f) as u8];
    value >>= 7;
    while value > 0 {
        value -= 1;
        bytes.push(0x80 | (value & 0x7f) as u8);
        value >>= 7;
    }
    bytes.reverse();
    buf.extend_from_slice(&bytes);
}

fn encode_delta_varint(buf: &mut Vec<u8>, mut value: usize) {
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

/// Build delta instructions producing `result` from `base`. Uses a copy
/// of the common prefix when `result` extends `base` (exercising the
/// copy path), and inserts for the rest.
fn make_delta(base: &[u8], result: &[u8]) -> Vec<u8> {
    let mut delta = Vec::new();
    encode_delta_varint(&mut delta, base.len());
    encode_delta_varint(&mut delta, result.len());

    let mut rest = result;
    if !base.is_empty() && base.len() <= 0x00ff_ffff && result.starts_with(base) {
        // copy(offset=0, size=base.len())
        let size = base.len();
        let mut cmd = 0x80u8;
        let mut size_bytes = Vec::new();
        for (bit, shift) in [(0x10u8, 0), (0x20u8, 8), (0x40u8, 16)] {
            let b = ((size >> shift) & 0xff) as u8;
            if b != 0 {
                cmd |= bit;
                size_bytes.push(b);
            }
        }
        delta.push(cmd);
        delta.extend_from_slice(&size_bytes);
        rest = &result[base.len()..];
    }

    for chunk in rest.chunks(127) {
        delta.push(chunk.len() as u8);
        delta.extend_from_slice(chunk);
    }
    delta
}

/// Incrementally builds a syntactically valid packfile with real object
/// offsets and a correct SHA-1 trailer.
pub struct PackBuilder {
    body: Vec<u8>,
    offsets: Vec<usize>,
}

impl PackBuilder {
    pub fn new() -> Self {
        Self {
            body: Vec::new(),
            offsets: Vec::new(),
        }
    }

    fn push_entry(&mut self, encoded: Vec<u8>) -> u32 {
        let idx = self.offsets.len() as u32;
        self.offsets.push(12 + self.body.len());
        self.body.extend_from_slice(&encoded);
        idx
    }

    /// Append a non-delta object with the given packfile type bits.
    pub fn object(&mut self, type_bits: u8, data: &[u8]) -> u32 {
        let mut buf = Vec::new();
        encode_object_header(&mut buf, type_bits, data.len());
        buf.extend_from_slice(&zlib_compress(data));
        self.push_entry(buf)
    }

    /// Append a blob object.
    pub fn blob(&mut self, data: &[u8]) -> u32 {
        self.object(3, data)
    }

    /// Append an OFS_DELTA against entry `base_idx`, producing `result`
    /// from `base_data`.
    pub fn ofs_delta(&mut self, base_idx: u32, base_data: &[u8], result: &[u8]) -> u32 {
        let delta = make_delta(base_data, result);
        let offset = 12 + self.body.len();
        let base_offset = self.offsets[base_idx as usize];
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 6, delta.len());
        encode_ofs_offset(&mut buf, offset - base_offset);
        buf.extend_from_slice(&zlib_compress(&delta));
        self.push_entry(buf)
    }

    /// Append a REF_DELTA whose base is the *blob* with `base_data`.
    pub fn ref_delta(&mut self, base_data: &[u8], result: &[u8]) -> u32 {
        self.raw_ref_delta(git_sha1(GitObjectType::Blob, base_data), base_data, result)
    }

    /// Append a REF_DELTA with an explicit base SHA-1 (may be bogus, for
    /// thin-pack tests).
    pub fn raw_ref_delta(&mut self, base_sha: [u8; 20], base_data: &[u8], result: &[u8]) -> u32 {
        let delta = make_delta(base_data, result);
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 7, delta.len());
        buf.extend_from_slice(&base_sha);
        buf.extend_from_slice(&zlib_compress(&delta));
        self.push_entry(buf)
    }

    fn finish(self, extra_objects: usize, extra_body: &[u8]) -> Vec<u8> {
        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&((self.offsets.len() + extra_objects) as u32).to_be_bytes());
        pack.extend_from_slice(&self.body);
        pack.extend_from_slice(extra_body);
        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);
        pack
    }

    /// Finalize: header, objects, SHA-1 trailer.
    pub fn build(self) -> Vec<u8> {
        self.finish(0, &[])
    }

    /// Finalize with one extra OFS_DELTA whose base distance is zero
    /// (self-referencing) appended at the end.
    pub fn build_with_self_ofs_delta(self) -> Vec<u8> {
        let delta = make_delta(b"x", b"xy");
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 6, delta.len());
        buf.push(0x00); // base distance 0 → points at itself
        buf.extend_from_slice(&zlib_compress(&delta));
        self.finish(1, &buf)
    }
}
