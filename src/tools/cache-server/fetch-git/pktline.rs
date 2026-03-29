// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git pkt-line protocol encoding and decoding.
//!
//! pkt-line is the fundamental framing protocol used by Git's transport layer.
//! Every message exchanged during ref discovery and pack negotiation is wrapped
//! in pkt-line frames.
//!
//! # Wire format
//!
//! Each frame starts with a 4-character hexadecimal length prefix that includes
//! the 4 bytes of the prefix itself:
//!
//! ```text
//! ┌──────────┬───────────────────────────┐
//! │ "000a"   │ hello\n                   │  ← data line (10 bytes total)
//! └──────────┴───────────────────────────┘
//!   4 bytes        6 bytes payload
//! ```
//!
//! Special length values:
//!
//! | Hex    | Meaning          | Constant              |
//! |--------|------------------|-----------------------|
//! | `0000` | Flush packet     | [`FLUSH_PKT`]         |
//! | `0001` | Delimiter packet | (protocol v2 only)    |
//! | `0002` | Response-end     | (not used here)       |
//!
//! Lengths 2 and 3 are invalid. A flush packet (`0000`) signals the end of a
//! message section and is used to separate the service announcement, ref list,
//! and pack data in the smart HTTP protocol.
//!
//! # Reference
//!
//! <https://git-scm.com/docs/protocol-common#_pkt_line_format>

use bytes::{Buf as _, Bytes, BytesMut};
use std::future::poll_fn;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};

use crate::GitFetchError;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// A single pkt-line frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PktLine {
    /// A data line (the payload, without the 4-byte length prefix).
    Data(Bytes),
    /// Flush packet (`0000`).
    Flush,
    /// Delimiter packet (`0001`).
    Delimiter,
}

// ---------------------------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------------------------

/// Parse a sequence of pkt-lines from a byte buffer.
///
/// Returns all parsed pkt-lines and the number of bytes consumed.
pub fn parse_pkt_lines(data: &[u8]) -> Result<Vec<PktLine>, GitFetchError> {
    let mut lines = Vec::new();
    let mut offset = 0;

    while offset < data.len() {
        if data.len() - offset < 4 {
            break;
        }

        let len_hex = std::str::from_utf8(&data[offset..offset + 4]).map_err(|_| {
            GitFetchError::InvalidPackfile("invalid pkt-line length: not ASCII".into())
        })?;

        let len = u16::from_str_radix(len_hex, 16).map_err(|_| {
            GitFetchError::InvalidPackfile(format!("invalid pkt-line length: {len_hex:?}"))
        })?;

        match len {
            0 => {
                lines.push(PktLine::Flush);
                offset += 4;
            }
            1 => {
                lines.push(PktLine::Delimiter);
                offset += 4;
            }
            2..=3 => {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "invalid pkt-line length: {len}"
                )));
            }
            _ => {
                let payload_len = (len as usize) - 4;
                if data.len() - offset - 4 < payload_len {
                    return Err(GitFetchError::InvalidPackfile(format!(
                        "truncated pkt-line: expected {payload_len} bytes, got {}",
                        data.len() - offset - 4
                    )));
                }
                let payload = Bytes::copy_from_slice(&data[offset + 4..offset + 4 + payload_len]);
                lines.push(PktLine::Data(payload));
                offset += 4 + payload_len;
            }
        }
    }

    Ok(lines)
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------------------------

/// Encode a data payload as a pkt-line (4-hex-char length prefix + payload).
pub fn encode_pkt_line(data: &[u8]) -> Vec<u8> {
    let total_len = data.len() + 4;
    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(format!("{total_len:04x}").as_bytes());
    out.extend_from_slice(data);
    out
}

/// The flush packet bytes.
pub const FLUSH_PKT: &[u8] = b"0000";

// ---------------------------------------------------------------------------------------------------------------
// Streaming reader
// ---------------------------------------------------------------------------------------------------------------

/// A streaming pkt-line frame reader.
///
/// Reads pkt-line frames incrementally from an [`AsyncRead`] source, handling
/// partial reads across chunk boundaries via an internal [`BytesMut`] buffer.
/// This allows processing pkt-line data as it arrives over a network socket
/// without buffering the entire response first.
///
/// Use [`next_line`](Self::next_line) for async contexts or
/// [`poll_next_line`](Self::poll_next_line) when implementing [`AsyncRead`] on
/// a wrapper type (e.g. a sideband demuxer).
pub struct StreamingPktLineReader<R> {
    reader: R,
    buf: BytesMut,
    /// Cached total frame length (including 4-byte prefix) from a partially
    /// buffered frame. Set once we've parsed the length prefix but don't yet
    /// have enough bytes for the full payload.
    parsed_frame_len: Option<usize>,
    eof: bool,
}

impl<R: AsyncRead + Unpin> StreamingPktLineReader<R> {
    /// Create a new streaming pkt-line reader wrapping the given source.
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buf: BytesMut::with_capacity(65536),
            parsed_frame_len: None,
            eof: false,
        }
    }

    /// Read the next pkt-line frame. Returns `None` at clean EOF.
    pub async fn next_line(&mut self) -> Result<Option<PktLine>, GitFetchError> {
        poll_fn(|cx| self.poll_next_line(cx)).await
    }

    /// Poll-based version of [`next_line`](Self::next_line) for use in
    /// [`AsyncRead`] implementations that cannot use `.await`.
    pub fn poll_next_line(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Option<PktLine>, GitFetchError>> {
        loop {
            // Step 1: Parse the 4-byte hex length prefix if we haven't yet.
            if self.parsed_frame_len.is_none() {
                if self.buf.len() < 4 {
                    if self.eof {
                        return if self.buf.is_empty() {
                            Poll::Ready(Ok(None))
                        } else {
                            Poll::Ready(Err(GitFetchError::InvalidPackfile(format!(
                                "truncated pkt-line: {} bytes remaining at EOF",
                                self.buf.len()
                            ))))
                        };
                    }
                    match self.poll_fill_buf(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(0)) => {
                            self.eof = true;
                            continue;
                        }
                        Poll::Ready(Ok(_)) => continue,
                        Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                    }
                }

                let len_hex = std::str::from_utf8(&self.buf[..4]).map_err(|_| {
                    GitFetchError::InvalidPackfile("invalid pkt-line length: not ASCII".into())
                })?;
                let len = u16::from_str_radix(len_hex, 16).map_err(|_| {
                    GitFetchError::InvalidPackfile(format!("invalid pkt-line length: {len_hex:?}"))
                })?;

                match len {
                    0 => {
                        self.buf.advance(4);
                        return Poll::Ready(Ok(Some(PktLine::Flush)));
                    }
                    1 => {
                        self.buf.advance(4);
                        return Poll::Ready(Ok(Some(PktLine::Delimiter)));
                    }
                    2..=3 => {
                        return Poll::Ready(Err(GitFetchError::InvalidPackfile(format!(
                            "invalid pkt-line length: {len}"
                        ))));
                    }
                    _ => {
                        self.parsed_frame_len = Some(len as usize);
                    }
                }
            }

            // Step 2: We know the total frame length; wait for enough bytes.
            let total_len = self.parsed_frame_len.unwrap();
            if self.buf.len() < total_len {
                if self.eof {
                    return Poll::Ready(Err(GitFetchError::InvalidPackfile(format!(
                        "truncated pkt-line: expected {total_len} bytes, got {}",
                        self.buf.len()
                    ))));
                }
                match self.poll_fill_buf(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(0)) => {
                        self.eof = true;
                        continue;
                    }
                    Poll::Ready(Ok(_)) => continue,
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                }
            }

            // Full frame available — extract payload (skip 4-byte prefix).
            let mut frame = self.buf.split_to(total_len);
            frame.advance(4);
            let payload = frame.freeze();
            self.parsed_frame_len = None;
            return Poll::Ready(Ok(Some(PktLine::Data(payload))));
        }
    }

    /// Try to read more data from the underlying reader into the buffer.
    fn poll_fill_buf(&mut self, cx: &mut Context<'_>) -> Poll<Result<usize, GitFetchError>> {
        let mut tmp = [0u8; 8192];
        let mut read_buf = ReadBuf::new(&mut tmp);
        match Pin::new(&mut self.reader).poll_read(cx, &mut read_buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Err(GitFetchError::RequestFailed(format!(
                "read pkt-line data: {e}"
            )))),
            Poll::Ready(Ok(())) => {
                let n = read_buf.filled().len();
                if n > 0 {
                    self.buf.extend_from_slice(read_buf.filled());
                }
                Poll::Ready(Ok(n))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Test utilities (shared across crate test modules)
// ---------------------------------------------------------------------------------------------------------------

/// Test utilities shared across crate test modules.
#[cfg(test)]
pub(crate) mod test_util {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use tokio::io::{AsyncRead, ReadBuf};

    /// A reader that delivers data in fixed-size chunks, simulating TCP
    /// segment boundaries for testing streaming parsers.
    pub struct ChunkedReader {
        data: Vec<u8>,
        pos: usize,
        chunk_size: usize,
    }

    impl ChunkedReader {
        pub fn new(data: Vec<u8>, chunk_size: usize) -> Self {
            Self {
                data,
                pos: 0,
                chunk_size,
            }
        }
    }

    impl AsyncRead for ChunkedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let remaining = &self.data[self.pos..];
            if remaining.is_empty() {
                return Poll::Ready(Ok(()));
            }
            let n = remaining.len().min(self.chunk_size).min(buf.remaining());
            buf.put_slice(&remaining[..n]);
            self.pos += n;
            Poll::Ready(Ok(()))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::test_util::ChunkedReader;
    use super::*;

    #[test]
    fn parse_flush_packet() {
        let data = b"0000";
        let lines = parse_pkt_lines(data).unwrap();
        assert_eq!(lines, vec![PktLine::Flush]);
    }

    #[test]
    fn parse_delimiter_packet() {
        let data = b"0001";
        let lines = parse_pkt_lines(data).unwrap();
        assert_eq!(lines, vec![PktLine::Delimiter]);
    }

    #[test]
    fn parse_data_line() {
        // length 0x000a = 10, payload = 10-4 = 6 bytes = "hello\n"
        let data = b"000ahello\n";
        let lines = parse_pkt_lines(data).unwrap();
        assert_eq!(lines, vec![PktLine::Data(Bytes::from_static(b"hello\n"))]);
    }

    #[test]
    fn parse_multiple_lines() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"0008foo\n");
        buf.extend_from_slice(b"0008bar\n");
        buf.extend_from_slice(b"0000");

        let lines = parse_pkt_lines(&buf).unwrap();
        assert_eq!(
            lines,
            vec![
                PktLine::Data(Bytes::from_static(b"foo\n")),
                PktLine::Data(Bytes::from_static(b"bar\n")),
                PktLine::Flush,
            ]
        );
    }

    #[test]
    fn encode_roundtrip() {
        let payload = b"hello world\n";
        let encoded = encode_pkt_line(payload);
        let lines = parse_pkt_lines(&encoded).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], PktLine::Data(Bytes::copy_from_slice(payload)));
    }

    #[test]
    fn encode_length_prefix() {
        let encoded = encode_pkt_line(b"abc");
        // Total length = 4 (header) + 3 (payload) = 7 = 0x0007
        assert_eq!(&encoded[..4], b"0007");
        assert_eq!(&encoded[4..], b"abc");
    }

    #[test]
    fn parse_truncated_payload_errors() {
        // Claims 10 bytes total but only 5 bytes of payload present
        let data = b"000ahi";
        let result = parse_pkt_lines(data);
        assert!(result.is_err());
    }

    #[test]
    fn parse_invalid_hex_errors() {
        let data = b"gggg";
        let result = parse_pkt_lines(data);
        assert!(result.is_err());
    }

    #[test]
    fn parse_real_ref_discovery_line() {
        // Simulates a line like: "00a0<hash> HEAD\0capability1 capability2\n"
        let sha = "0000000000000000000000000000000000000000";
        let payload = format!("{sha} HEAD\0multi_ack side-band-64k\n");
        let encoded = encode_pkt_line(payload.as_bytes());

        let lines = parse_pkt_lines(&encoded).unwrap();
        assert_eq!(lines.len(), 1);
        if let PktLine::Data(data) = &lines[0] {
            let s = std::str::from_utf8(data).unwrap();
            assert!(s.contains("HEAD"));
            assert!(s.contains("multi_ack"));
        } else {
            panic!("expected Data line");
        }
    }

    // --- Streaming pkt-line reader tests ---

    #[tokio::test]
    async fn streaming_flush() {
        let data = b"0000".to_vec();
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(data));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, Some(PktLine::Flush));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, None);
    }

    #[tokio::test]
    async fn streaming_delimiter() {
        let data = b"0001".to_vec();
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(data));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, Some(PktLine::Delimiter));
    }

    #[tokio::test]
    async fn streaming_data_line() {
        let encoded = encode_pkt_line(b"hello\n");
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(encoded));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, Some(PktLine::Data(Bytes::from_static(b"hello\n"))));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, None);
    }

    #[tokio::test]
    async fn streaming_multiple_lines() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(b"foo\n"));
        buf.extend_from_slice(&encode_pkt_line(b"bar\n"));
        buf.extend_from_slice(FLUSH_PKT);

        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(buf));
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some(PktLine::Data(Bytes::from_static(b"foo\n")))
        );
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some(PktLine::Data(Bytes::from_static(b"bar\n")))
        );
        assert_eq!(reader.next_line().await.unwrap(), Some(PktLine::Flush));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn streaming_chunked_one_byte() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(b"hello world\n"));
        buf.extend_from_slice(FLUSH_PKT);

        let mut reader = StreamingPktLineReader::new(ChunkedReader::new(buf, 1));
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some(PktLine::Data(Bytes::from_static(b"hello world\n")))
        );
        assert_eq!(reader.next_line().await.unwrap(), Some(PktLine::Flush));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn streaming_chunked_splits_length_prefix() {
        // 3-byte chunks split the 4-byte length prefix across reads
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(b"data"));
        buf.extend_from_slice(FLUSH_PKT);

        let mut reader = StreamingPktLineReader::new(ChunkedReader::new(buf, 3));
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some(PktLine::Data(Bytes::from_static(b"data")))
        );
        assert_eq!(reader.next_line().await.unwrap(), Some(PktLine::Flush));
    }

    #[tokio::test]
    async fn streaming_eof_clean() {
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(Vec::new()));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn streaming_eof_truncated_prefix() {
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(b"00".to_vec()));
        assert!(reader.next_line().await.is_err());
    }

    #[tokio::test]
    async fn streaming_eof_truncated_payload() {
        // Claims 10 bytes total (6 payload) but only 2 payload bytes present
        let mut reader = StreamingPktLineReader::new(std::io::Cursor::new(b"000ahi".to_vec()));
        assert!(reader.next_line().await.is_err());
    }

    #[tokio::test]
    async fn streaming_matches_batch() {
        // Build a realistic multi-line response and verify streaming matches batch
        let sha = "0000000000000000000000000000000000000000";
        let payload = format!("{sha} HEAD\0multi_ack side-band-64k\n");

        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(payload.as_bytes()));
        buf.extend_from_slice(&encode_pkt_line(b"another line\n"));
        buf.extend_from_slice(FLUSH_PKT);
        buf.extend_from_slice(&encode_pkt_line(b"after flush\n"));
        buf.extend_from_slice(FLUSH_PKT);

        let batch = parse_pkt_lines(&buf).unwrap();

        let mut reader = StreamingPktLineReader::new(ChunkedReader::new(buf, 7));
        let mut streaming = Vec::new();
        while let Some(line) = reader.next_line().await.unwrap() {
            streaming.push(line);
        }

        assert_eq!(batch, streaming);
    }

    #[tokio::test]
    async fn streaming_large_payload() {
        // Test a pkt-line near the maximum size
        let payload = vec![0xAB; 1000];
        let encoded = encode_pkt_line(&payload);

        let mut reader = StreamingPktLineReader::new(ChunkedReader::new(encoded, 50));
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, Some(PktLine::Data(Bytes::from(payload))));
    }
}
