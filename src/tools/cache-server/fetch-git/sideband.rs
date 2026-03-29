// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Streaming side-band-64k demultiplexer for Git smart HTTP responses.
//!
//! After the server sends `NAK` (or `ACK`) to the client's `want` request,
//! the remainder of the response is side-band multiplexed. Each pkt-line's
//! first byte is a channel indicator:
//!
//! - **Channel 1** (`0x01`): packfile data
//! - **Channel 2** (`0x02`): progress/status messages
//! - **Channel 3** (`0x03`): fatal error from the server
//!
//! [`SidebandReader`] wraps a [`StreamingPktLineReader`] and implements
//! [`AsyncRead`], yielding only the channel-1 packfile bytes. Progress
//! messages are logged at debug level; errors cause the reader to fail.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf as _, Bytes};
use tokio::io::{AsyncRead, ReadBuf};

use crate::GitFetchError;
use crate::pktline::{PktLine, StreamingPktLineReader};

// ---------------------------------------------------------------------------------------------------------------
// Sideband state machine
// ---------------------------------------------------------------------------------------------------------------

/// Processing phase for the sideband demuxer.
enum State {
    /// Reading pkt-lines before NAK/ACK. Skips shallow/unshallow lines.
    PreNak,
    /// Reading side-band multiplexed pkt-lines after NAK/ACK.
    PostNak,
    /// Terminal — reached clean EOF or a fatal error.
    Done,
}

// ---------------------------------------------------------------------------------------------------------------
// SidebandReader
// ---------------------------------------------------------------------------------------------------------------

/// Async reader that extracts channel-1 (packfile) data from a side-band-64k
/// multiplexed Git response.
///
/// Wraps a [`StreamingPktLineReader`] and implements [`AsyncRead`]. Callers
/// read packfile bytes directly from this reader; progress messages (channel 2)
/// are logged at debug level, and server errors (channel 3) are surfaced as
/// I/O errors.
pub struct SidebandReader<R> {
    inner: StreamingPktLineReader<R>,
    state: State,
    /// Buffered channel-1 payload from the current pkt-line frame.
    pending: Bytes,
}

impl<R: AsyncRead + Unpin> SidebandReader<R> {
    /// Create a new sideband reader wrapping a pkt-line reader.
    pub fn new(inner: StreamingPktLineReader<R>) -> Self {
        Self {
            inner,
            state: State::PreNak,
            pending: Bytes::new(),
        }
    }

    /// Create a sideband reader directly from an [`AsyncRead`] source,
    /// constructing the pkt-line reader internally.
    pub fn from_reader(reader: R) -> Self {
        Self::new(StreamingPktLineReader::new(reader))
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for SidebandReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();

        loop {
            // Step 1: Drain any buffered channel-1 data.
            if !this.pending.is_empty() {
                let n = this.pending.len().min(buf.remaining());
                buf.put_slice(&this.pending[..n]);
                this.pending.advance(n);
                return Poll::Ready(Ok(()));
            }

            // Step 2: Check terminal state.
            if matches!(this.state, State::Done) {
                return Poll::Ready(Ok(()));
            }

            // Step 3: Get next pkt-line.
            let line = match this.inner.poll_next_line(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(e)) => {
                    this.state = State::Done;
                    return Poll::Ready(Err(io::Error::other(e)));
                }
                Poll::Ready(Ok(None)) => {
                    this.state = State::Done;
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Ok(Some(line))) => line,
            };

            // Step 4: Process based on state.
            match (&this.state, &line) {
                (State::PreNak, PktLine::Flush | PktLine::Delimiter) => continue,

                (State::PreNak, PktLine::Data(data)) => {
                    if data.is_empty() {
                        continue;
                    }
                    // Check for NAK/ACK or shallow/unshallow text lines.
                    if let Ok(text) = std::str::from_utf8(data) {
                        let trimmed = text.trim();
                        if trimmed == "NAK" || trimmed.starts_with("ACK ") {
                            this.state = State::PostNak;
                            continue;
                        }
                        if trimmed.starts_with("shallow ") || trimmed.starts_with("unshallow ") {
                            continue;
                        }
                        // Servers report failures (bad want, access denied)
                        // as an ERR line before any sideband data.
                        if let Some(msg) = trimmed.strip_prefix("ERR ") {
                            this.state = State::Done;
                            return Poll::Ready(Err(io::Error::other(
                                GitFetchError::RequestFailed(format!("remote error: {msg}")),
                            )));
                        }
                    }
                    // Binary detection: if first byte is a channel indicator
                    // (1-3) without a preceding NAK text line, treat as
                    // side-band data.
                    if data[0] <= 3 {
                        this.state = State::PostNak;
                        // Fall through to process this frame as side-band.
                    } else {
                        continue;
                    }
                }

                (State::PostNak, PktLine::Flush) => {
                    this.state = State::Done;
                    return Poll::Ready(Ok(()));
                }
                (State::PostNak, PktLine::Delimiter) => continue,

                (State::PostNak, PktLine::Data(data)) if data.is_empty() => continue,

                _ => {}
            }

            // Process side-band data (we're in PostNak with a Data line).
            if let PktLine::Data(data) = line {
                if data.is_empty() {
                    continue;
                }
                let channel = data[0];
                match channel {
                    1 => {
                        if data.len() > 1 {
                            this.pending = data.slice(1..);
                            // Loop back to drain step.
                        }
                    }
                    2 => {
                        if let Ok(msg) = std::str::from_utf8(&data[1..]) {
                            tracing::debug!(target: "git_fetch", "remote: {}", msg.trim());
                        }
                    }
                    3 => {
                        let msg = std::str::from_utf8(&data[1..])
                            .unwrap_or("unknown error")
                            .trim()
                            .to_string();
                        this.state = State::Done;
                        return Poll::Ready(Err(io::Error::other(GitFetchError::RequestFailed(
                            format!("remote error: {msg}"),
                        ))));
                    }
                    _ => {
                        // Unknown channel, skip.
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt as _;

    use crate::pktline;

    use super::*;

    /// Helper: build a complete sideband response from parts.
    fn build_sideband_response(parts: &[SidebandPart]) -> Vec<u8> {
        let mut buf = Vec::new();
        for part in parts {
            match part {
                SidebandPart::Nak => {
                    buf.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));
                }
                SidebandPart::Ack(sha) => {
                    let line = format!("ACK {sha}\n");
                    buf.extend_from_slice(&pktline::encode_pkt_line(line.as_bytes()));
                }
                SidebandPart::Shallow(sha) => {
                    let line = format!("shallow {sha}\n");
                    buf.extend_from_slice(&pktline::encode_pkt_line(line.as_bytes()));
                }
                SidebandPart::PackData(data) => {
                    let mut frame = vec![1u8];
                    frame.extend_from_slice(data);
                    buf.extend_from_slice(&pktline::encode_pkt_line(&frame));
                }
                SidebandPart::Progress(msg) => {
                    let mut frame = vec![2u8];
                    frame.extend_from_slice(msg.as_bytes());
                    buf.extend_from_slice(&pktline::encode_pkt_line(&frame));
                }
                SidebandPart::Error(msg) => {
                    let mut frame = vec![3u8];
                    frame.extend_from_slice(msg.as_bytes());
                    buf.extend_from_slice(&pktline::encode_pkt_line(&frame));
                }
                SidebandPart::Flush => {
                    buf.extend_from_slice(pktline::FLUSH_PKT);
                }
            }
        }
        buf
    }

    enum SidebandPart {
        Nak,
        Ack(String),
        Shallow(String),
        PackData(&'static [u8]),
        Progress(String),
        Error(String),
        Flush,
    }

    async fn read_all_sideband(data: Vec<u8>) -> io::Result<Vec<u8>> {
        let mut reader = SidebandReader::from_reader(std::io::Cursor::new(data));
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await?;
        Ok(out)
    }

    #[tokio::test]
    async fn basic_nak_and_pack_data() {
        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::PackData(b"PACK"),
            SidebandPart::Flush,
        ]);
        let result = read_all_sideband(data).await.unwrap();
        assert_eq!(result, b"PACK");
    }

    #[tokio::test]
    async fn multiple_pack_chunks() {
        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::PackData(b"hel"),
            SidebandPart::PackData(b"lo "),
            SidebandPart::PackData(b"world"),
            SidebandPart::Flush,
        ]);
        let result = read_all_sideband(data).await.unwrap();
        assert_eq!(result, b"hello world");
    }

    #[tokio::test]
    async fn progress_messages_skipped() {
        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::Progress("Counting objects: 42\n".into()),
            SidebandPart::PackData(b"DATA"),
            SidebandPart::Progress("Compressing objects: 100%\n".into()),
            SidebandPart::Flush,
        ]);
        let result = read_all_sideband(data).await.unwrap();
        assert_eq!(result, b"DATA");
    }

    #[tokio::test]
    async fn error_channel_returns_error() {
        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::PackData(b"some"),
            SidebandPart::Error("upload-pack: not our ref\n".into()),
            SidebandPart::Flush,
        ]);
        let err = read_all_sideband(data).await.unwrap_err();
        assert!(err.to_string().contains("not our ref"));
    }

    #[tokio::test]
    async fn err_line_before_nak_fails() {
        // "ERR <msg>" instead of NAK: the server refused the want request.
        let mut buf = Vec::new();
        buf.extend_from_slice(&pktline::encode_pkt_line(b"ERR upload-pack: not our ref\n"));
        buf.extend_from_slice(pktline::FLUSH_PKT);
        let err = read_all_sideband(buf).await.unwrap_err();
        assert!(err.to_string().contains("not our ref"), "{err}");
    }

    #[tokio::test]
    async fn shallow_lines_before_nak() {
        let sha = "aabbccddee00112233445566778899aabbccddee";
        let data = build_sideband_response(&[
            SidebandPart::Shallow(sha.into()),
            SidebandPart::Nak,
            SidebandPart::PackData(b"PACK"),
            SidebandPart::Flush,
        ]);
        let result = read_all_sideband(data).await.unwrap();
        assert_eq!(result, b"PACK");
    }

    #[tokio::test]
    async fn ack_instead_of_nak() {
        let data = build_sideband_response(&[
            SidebandPart::Ack("aabbccddee00112233445566778899aabbccddee".into()),
            SidebandPart::PackData(b"DATA"),
            SidebandPart::Flush,
        ]);
        let result = read_all_sideband(data).await.unwrap();
        assert_eq!(result, b"DATA");
    }

    #[tokio::test]
    async fn binary_sideband_without_explicit_nak() {
        // Some servers send side-band data with channel indicator byte directly,
        // without a preceding text NAK line.
        let mut buf = Vec::new();
        let mut frame = vec![1u8]; // channel 1
        frame.extend_from_slice(b"PACK");
        buf.extend_from_slice(&pktline::encode_pkt_line(&frame));
        buf.extend_from_slice(pktline::FLUSH_PKT);

        let result = read_all_sideband(buf).await.unwrap();
        assert_eq!(result, b"PACK");
    }

    #[tokio::test]
    async fn matches_batch_extract() {
        use crate::extract_packfile_from_sideband;

        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::PackData(b"hello "),
            SidebandPart::Progress("status\n".into()),
            SidebandPart::PackData(b"world"),
            SidebandPart::Flush,
        ]);

        let batch_result = extract_packfile_from_sideband(&data).unwrap();
        let streaming_result = read_all_sideband(data).await.unwrap();
        assert_eq!(batch_result, streaming_result);
    }

    #[tokio::test]
    async fn chunked_delivery() {
        use crate::pktline::test_util::ChunkedReader;

        let data = build_sideband_response(&[
            SidebandPart::Nak,
            SidebandPart::PackData(b"chunked data test"),
            SidebandPart::Flush,
        ]);

        let mut reader = SidebandReader::from_reader(ChunkedReader::new(data, 3));
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"chunked data test");
    }

    #[tokio::test]
    async fn empty_response_eof() {
        // Just a flush with no data after NAK
        let data = build_sideband_response(&[SidebandPart::Nak, SidebandPart::Flush]);
        let result = read_all_sideband(data).await.unwrap();
        assert!(result.is_empty());
    }
}
