// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Compression algorithm support for chunk storage.

use std::borrow::Cow;
use std::fmt;
use std::io::{Cursor, Read as _, Write as _};
use std::str::FromStr;

use anyhow::Context as _;
use bytes::Bytes;

use super::error::{Result, StoreError};

// Maximum decompressed size for any single chunk (16 MiB, well above CDC_MAX_SIZE)
pub(crate) const MAX_CHUNK_DECOMPRESSED_SIZE: usize = 16 * 1024 * 1024;

/// Compression algorithm identifier.
///
/// The `repr(u8)` values conveniently align with proto `Compressor.Value`.
/// Use `from_proto_i32` / `to_proto_i32` for proto conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Compression {
    Identity = 0,
    Zstd = 1,
    Deflate = 2,
    Brotli = 3,
}

impl Compression {
    /// Compress `data` using this algorithm. Identity borrows without copying.
    pub fn compress<'a>(&self, data: &'a [u8]) -> Result<Cow<'a, [u8]>> {
        match self {
            Compression::Identity => Ok(Cow::Borrowed(data)),
            Compression::Zstd => zstd::bulk::compress(data, 3)
                .map(Cow::Owned)
                .map_err(|e| StoreError::CompressionFailed(format!("zstd: {e}"))),
            Compression::Deflate => {
                let mut encoder = flate2::write::DeflateEncoder::new(
                    Vec::with_capacity(data.len()),
                    flate2::Compression::new(6),
                );
                encoder
                    .write_all(data)
                    .map_err(|e| StoreError::CompressionFailed(format!("deflate: {e}")))?;
                encoder
                    .finish()
                    .map(Cow::Owned)
                    .map_err(|e| StoreError::CompressionFailed(format!("deflate: {e}")))
            }
            Compression::Brotli => {
                let mut output = Vec::with_capacity(data.len());
                {
                    let mut encoder = brotli::CompressorWriter::new(&mut output, 4096, 4, 20);
                    encoder
                        .write_all(data)
                        .map_err(|e| StoreError::CompressionFailed(format!("brotli: {e}")))?;
                }
                Ok(Cow::Owned(output))
            }
        }
    }

    /// Decompress `data` using this algorithm. Identity borrows without copying.
    ///
    /// All codecs are capped at `MAX_CHUNK_DECOMPRESSED_SIZE` to prevent
    /// decompression bombs.
    pub fn decompress<'a>(&self, data: &'a [u8]) -> Result<Cow<'a, [u8]>> {
        self.decompress_inner(data, None)
    }

    /// Decompress `data` with a known expected size.
    ///
    /// The `expected_size` is used as an initial buffer capacity hint for
    /// pre-allocation (capped internally). The decompression output is always
    /// limited to `MAX_CHUNK_DECOMPRESSED_SIZE` regardless of the hint.
    pub fn decompress_with_size_hint<'a>(
        &self,
        data: &'a [u8],
        expected_size: usize,
    ) -> Result<Cow<'a, [u8]>> {
        self.decompress_inner(data, Some(expected_size))
    }

    /// Unified decompression with optional size hint.
    ///
    /// The decompression ceiling is always `MAX_CHUNK_DECOMPRESSED_SIZE`.
    /// The `size_hint` only influences initial buffer capacity for
    /// pre-allocation — it never restricts the decompression output.
    fn decompress_inner<'a>(
        &self,
        data: &'a [u8],
        size_hint: Option<usize>,
    ) -> Result<Cow<'a, [u8]>> {
        let limit = MAX_CHUNK_DECOMPRESSED_SIZE;

        match self {
            Compression::Identity => Ok(Cow::Borrowed(data)),
            Compression::Zstd => {
                let capacity = size_hint.unwrap_or(data.len().saturating_mul(4)).min(limit);
                let decoder = zstd::stream::read::Decoder::new(Cursor::new(data))
                    .map_err(|e| StoreError::CompressionFailed(format!("zstd: {e}")))?;
                let mut limited = std::io::Read::take(decoder, limit as u64);
                let mut output = Vec::with_capacity(capacity);
                limited
                    .read_to_end(&mut output)
                    .map_err(|e| StoreError::CompressionFailed(format!("zstd: {e}")))?;
                let mut probe = [0u8; 1];
                if limited.into_inner().read(&mut probe).unwrap_or(0) > 0 {
                    return Err(StoreError::CompressionFailed(format!(
                        "zstd: decompressed size exceeds limit {limit}"
                    )));
                }
                Ok(Cow::Owned(output))
            }
            Compression::Deflate => {
                let capacity = size_hint.unwrap_or(data.len().saturating_mul(2)).min(limit);
                let decoder = flate2::read::DeflateDecoder::new(data);
                let mut limited = std::io::Read::take(decoder, limit as u64);
                let mut output = Vec::with_capacity(capacity);
                limited
                    .read_to_end(&mut output)
                    .map_err(|e| StoreError::CompressionFailed(format!("deflate: {e}")))?;
                let mut probe = [0u8; 1];
                if limited.into_inner().read(&mut probe).unwrap_or(0) > 0 {
                    return Err(StoreError::CompressionFailed(format!(
                        "deflate: decompressed size exceeds limit {limit}"
                    )));
                }
                Ok(Cow::Owned(output))
            }
            Compression::Brotli => {
                let capacity = size_hint.unwrap_or(data.len().saturating_mul(2)).min(limit);
                let decoder = brotli::Decompressor::new(data, 4096);
                let mut limited = std::io::Read::take(decoder, limit as u64);
                let mut output = Vec::with_capacity(capacity);
                limited
                    .read_to_end(&mut output)
                    .map_err(|e| StoreError::CompressionFailed(format!("brotli: {e}")))?;
                let mut probe = [0u8; 1];
                if limited.into_inner().read(&mut probe).unwrap_or(0) > 0 {
                    return Err(StoreError::CompressionFailed(format!(
                        "brotli: decompressed size exceeds limit {limit}"
                    )));
                }
                Ok(Cow::Owned(output))
            }
        }
    }

    /// Async compress: runs `compress` on a blocking thread for non-Identity codecs.
    pub async fn compress_async(&self, data: Bytes) -> Result<Bytes> {
        if *self == Compression::Identity {
            return Ok(data);
        }
        let comp = *self;
        tokio::task::spawn_blocking(move || {
            let compressed = comp.compress(&data)?;
            Ok(Bytes::from(compressed.into_owned()))
        })
        .await
        .map_err(|e| StoreError::CompressionFailed(format!("spawn_blocking: {e}")))?
    }

    /// Async decompress with size hint: runs on a blocking thread for non-Identity codecs.
    pub async fn decompress_with_size_hint_async(
        &self,
        data: Bytes,
        expected_size: usize,
    ) -> Result<Bytes> {
        if *self == Compression::Identity {
            return Ok(data);
        }
        let comp = *self;
        tokio::task::spawn_blocking(move || {
            let decompressed = comp.decompress_with_size_hint(&data, expected_size)?;
            Ok(Bytes::from(decompressed.into_owned()))
        })
        .await
        .map_err(|e| StoreError::CompressionFailed(format!("spawn_blocking: {e}")))?
    }

    /// Async decompress: runs on a blocking thread for non-Identity codecs.
    pub async fn decompress_async(&self, data: Bytes) -> Result<Bytes> {
        if *self == Compression::Identity {
            return Ok(data);
        }
        let comp = *self;
        tokio::task::spawn_blocking(move || {
            let decompressed = comp.decompress(&data)?;
            Ok(Bytes::from(decompressed.into_owned()))
        })
        .await
        .map_err(|e| StoreError::CompressionFailed(format!("spawn_blocking: {e}")))?
    }

    /// Convert from a proto `Compressor.Value` i32.
    ///
    /// Proto values: 0 = IDENTITY, 1 = ZSTD, 2 = DEFLATE, 3 = BROTLI.
    /// Returns `None` for unsupported values.
    pub fn from_proto_i32(v: i32) -> Option<Self> {
        match v {
            0 => Some(Compression::Identity),
            1 => Some(Compression::Zstd),
            2 => Some(Compression::Deflate),
            3 => Some(Compression::Brotli),
            _ => None,
        }
    }

    /// Convert to the proto `Compressor.Value` i32.
    pub fn to_proto_i32(&self) -> i32 {
        *self as i32
    }

    /// Convert from raw `u8` discriminator.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Compression::Identity),
            1 => Some(Compression::Zstd),
            2 => Some(Compression::Deflate),
            3 => Some(Compression::Brotli),
            _ => None,
        }
    }

    /// Short lowercase name for logging and CLI.
    pub fn as_str(&self) -> &'static str {
        match self {
            Compression::Identity => "identity",
            Compression::Zstd => "zstd",
            Compression::Deflate => "deflate",
            Compression::Brotli => "brotli",
        }
    }

    /// Parse from a string name (case-insensitive).
    pub fn from_str_name(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "identity" => Some(Compression::Identity),
            "zstd" => Some(Compression::Zstd),
            "deflate" => Some(Compression::Deflate),
            "brotli" => Some(Compression::Brotli),
            _ => None,
        }
    }
}

// Output buffer size for streaming decompression (256 KiB).
const STREAMING_DECOMPRESS_BUF_SIZE: usize = 256 * 1024;

/// Incremental decompressor that processes compressed data in pieces.
///
/// Feed compressed chunks via [`write`](Self::write) and collect decompressed
/// output. Call [`finish`](Self::finish) to flush remaining buffered data and
/// verify stream completeness. Enforces a total decompressed size limit.
pub struct StreamingDecompressor {
    inner: DecompressorInner,
    total_out: usize,
    limit: usize,
}

enum DecompressorInner {
    Identity,
    Zstd(zstd::stream::raw::Decoder<'static>, Vec<u8>),
    Deflate(flate2::Decompress, Vec<u8>),
    Brotli(brotli::DecompressorWriter<Vec<u8>>),
}

impl Compression {
    /// Create a streaming decompressor for this codec with the given size limit.
    ///
    /// Identity codec passes data through without buffering. For other codecs,
    /// the decompressor maintains internal state across calls to
    /// [`StreamingDecompressor::write`].
    pub fn streaming_decompressor(self, size_limit: usize) -> Result<StreamingDecompressor> {
        let inner = match self {
            Compression::Identity => DecompressorInner::Identity,
            Compression::Zstd => {
                let decoder = zstd::stream::raw::Decoder::new()
                    .map_err(|e| StoreError::CompressionFailed(format!("zstd init: {e}")))?;
                DecompressorInner::Zstd(decoder, vec![0u8; STREAMING_DECOMPRESS_BUF_SIZE])
            }
            Compression::Deflate => DecompressorInner::Deflate(
                flate2::Decompress::new(false),
                vec![0u8; STREAMING_DECOMPRESS_BUF_SIZE],
            ),
            Compression::Brotli => {
                DecompressorInner::Brotli(brotli::DecompressorWriter::new(Vec::new(), 4096))
            }
        };
        Ok(StreamingDecompressor {
            inner,
            total_out: 0,
            limit: size_limit,
        })
    }
}

fn check_decompression_limit(total_out: usize, limit: usize, codec: &str) -> Result<()> {
    if total_out > limit {
        return Err(StoreError::CompressionFailed(format!(
            "{codec}: decompressed size {total_out} exceeds limit {limit}"
        )));
    }
    Ok(())
}

impl StreamingDecompressor {
    /// Feed compressed data and get decompressed output.
    ///
    /// May return empty `Bytes` if the codec needs more input to produce
    /// output. Fails early if the cumulative decompressed size exceeds the
    /// configured limit.
    pub fn write(&mut self, compressed: &[u8]) -> Result<Bytes> {
        if compressed.is_empty() {
            return Ok(Bytes::new());
        }
        match &mut self.inner {
            DecompressorInner::Identity => {
                self.total_out += compressed.len();
                check_decompression_limit(self.total_out, self.limit, "identity")?;
                Ok(Bytes::copy_from_slice(compressed))
            }
            DecompressorInner::Zstd(decoder, out_buf) => {
                use zstd::stream::raw::Operation as _;

                let mut output = bytes::BytesMut::with_capacity(compressed.len() * 2);
                let mut src_pos = 0;
                loop {
                    let status = decoder
                        .run_on_buffers(&compressed[src_pos..], out_buf)
                        .map_err(|e| StoreError::CompressionFailed(format!("zstd: {e}")))?;
                    src_pos += status.bytes_read;
                    if status.bytes_written > 0 {
                        self.total_out += status.bytes_written;
                        check_decompression_limit(self.total_out, self.limit, "zstd")?;
                        output.extend_from_slice(&out_buf[..status.bytes_written]);
                    }
                    if src_pos >= compressed.len() && status.bytes_written == 0 {
                        break;
                    }
                    if status.bytes_read == 0 && status.bytes_written == 0 {
                        break;
                    }
                }
                Ok(output.freeze())
            }
            DecompressorInner::Deflate(decompress, out_buf) => {
                let mut output = bytes::BytesMut::with_capacity(compressed.len() * 2);
                let mut src_pos = 0;
                loop {
                    let before_in = decompress.total_in();
                    let before_out = decompress.total_out();
                    let status = decompress
                        .decompress(
                            &compressed[src_pos..],
                            out_buf,
                            flate2::FlushDecompress::None,
                        )
                        .map_err(|e| StoreError::CompressionFailed(format!("deflate: {e}")))?;
                    let consumed = (decompress.total_in() - before_in) as usize;
                    let produced = (decompress.total_out() - before_out) as usize;
                    src_pos += consumed;
                    if produced > 0 {
                        self.total_out += produced;
                        check_decompression_limit(self.total_out, self.limit, "deflate")?;
                        output.extend_from_slice(&out_buf[..produced]);
                    }
                    if matches!(status, flate2::Status::StreamEnd) {
                        break;
                    }
                    if consumed == 0 && produced == 0 {
                        break;
                    }
                }
                Ok(output.freeze())
            }
            DecompressorInner::Brotli(writer) => {
                let mut output = bytes::BytesMut::with_capacity(compressed.len() * 2);
                // Feed input in small chunks so the limit check fires before
                // unbounded expansion can occur.
                const FEED_SIZE: usize = 16 * 1024;
                for piece in compressed.chunks(FEED_SIZE) {
                    writer
                        .write_all(piece)
                        .map_err(|e| StoreError::CompressionFailed(format!("brotli: {e}")))?;
                    let decompressed = writer.get_mut();
                    let produced = decompressed.len();
                    if produced > 0 {
                        self.total_out += produced;
                        check_decompression_limit(self.total_out, self.limit, "brotli")?;
                        output.extend_from_slice(decompressed);
                        decompressed.clear();
                    }
                }
                Ok(output.freeze())
            }
        }
    }

    /// Signal end of compressed stream and return any remaining buffered output.
    ///
    /// Returns an error if the compressed stream is incomplete.
    pub fn finish(self) -> Result<Bytes> {
        let StreamingDecompressor {
            inner,
            mut total_out,
            limit,
        } = self;
        match inner {
            DecompressorInner::Identity => Ok(Bytes::new()),
            DecompressorInner::Zstd(mut decoder, mut out_buf) => {
                use zstd::stream::raw::Operation as _;

                let mut output = bytes::BytesMut::with_capacity(256);
                loop {
                    let status = decoder
                        .run_on_buffers(&[], &mut out_buf)
                        .map_err(|e| StoreError::CompressionFailed(format!("zstd: {e}")))?;
                    if status.bytes_written > 0 {
                        total_out += status.bytes_written;
                        check_decompression_limit(total_out, limit, "zstd")?;
                        output.extend_from_slice(&out_buf[..status.bytes_written]);
                    } else {
                        break;
                    }
                }
                Ok(output.freeze())
            }
            DecompressorInner::Deflate(mut decompress, mut out_buf) => {
                let mut output = bytes::BytesMut::with_capacity(256);
                loop {
                    let before_out = decompress.total_out();
                    let status = decompress
                        .decompress(&[], &mut out_buf, flate2::FlushDecompress::Finish)
                        .map_err(|e| StoreError::CompressionFailed(format!("deflate: {e}")))?;
                    let produced = (decompress.total_out() - before_out) as usize;
                    if produced > 0 {
                        total_out += produced;
                        check_decompression_limit(total_out, limit, "deflate")?;
                        output.extend_from_slice(&out_buf[..produced]);
                    }
                    if matches!(status, flate2::Status::StreamEnd) || produced == 0 {
                        break;
                    }
                }
                Ok(output.freeze())
            }
            DecompressorInner::Brotli(mut writer) => {
                writer
                    .close()
                    .map_err(|e| StoreError::CompressionFailed(format!("brotli: {e}")))?;
                let decompressed = writer.get_mut();
                let produced = decompressed.len();
                if produced > 0 {
                    total_out += produced;
                    check_decompression_limit(total_out, limit, "brotli")?;
                }
                Ok(Bytes::from(std::mem::take(decompressed)))
            }
        }
    }

    /// Total decompressed bytes produced so far.
    pub fn total_out(&self) -> usize {
        self.total_out
    }
}

impl fmt::Display for Compression {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Compression {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> anyhow::Result<Self> {
        Self::from_str_name(s).context(format!("unknown compression: {}", s))
    }
}
