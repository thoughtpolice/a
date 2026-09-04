// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The byte-oriented control protocol shared with Fozzie's target runtime.
//!
//! This module deliberately does not use `repr(C)` structures. Every field is
//! encoded at the offsets specified by `runtime/protocol.h`, which keeps the
//! wire format independent of Rust and C structure layout.

use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u16 = 1;
pub const SHM_LAYOUT_VERSION: u32 = 1;

pub const SHM_HEADER_SIZE: usize = 128;
pub const FEATURE_ENTRY_SIZE: usize = 8;
pub const CMP_ENTRY_SIZE: usize = 32;

pub const FRAME_HEADER_SIZE: usize = 8;
pub const HELLO_FRAME_SIZE: usize = 32;
pub const RUN_FRAME_SIZE: usize = 24;
pub const STOP_FRAME_SIZE: usize = 16;
pub const DONE_FRAME_SIZE: usize = 40;

pub const FRAME_HELLO: u8 = 1;
pub const FRAME_RUN: u8 = 2;
pub const FRAME_STOP: u8 = 3;
pub const FRAME_DONE: u8 = 4;

pub const CAP_INLINE_8BIT_COUNTERS: u64 = 1 << 0;
pub const CAP_PC_TABLE: u64 = 1 << 1;
pub const CAP_TRACE_CMP: u64 = 1 << 2;

pub const DONE_OK: u32 = 0;
pub const DONE_HARNESS_NONZERO: u32 = 1;

pub const DONE_FEATURES_TRUNCATED: u32 = 1 << 0;
pub const DONE_COMPARISONS_TRUNCATED: u32 = 1 << 1;

pub const CMP_PLAIN: u8 = 0;
pub const CMP_CONST: u8 = 1;
pub const CMP_SWITCH: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CmpKind {
    Plain = CMP_PLAIN,
    Const = CMP_CONST,
    Switch = CMP_SWITCH,
}

impl CmpKind {
    pub fn from_raw(value: u8) -> io::Result<Self> {
        match value {
            CMP_PLAIN => Ok(Self::Plain),
            CMP_CONST => Ok(Self::Const),
            CMP_SWITCH => Ok(Self::Switch),
            _ => Err(invalid_data(format!("unknown comparison kind {value}"))),
        }
    }

    pub const fn as_raw(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HelloFrame {
    pub layout_version: u32,
    pub capabilities: u64,
    pub counter_count: u64,
}

impl HelloFrame {
    pub fn encode(&self) -> [u8; HELLO_FRAME_SIZE] {
        let mut frame = initialized_frame::<HELLO_FRAME_SIZE>(FRAME_HELLO);
        put_u32(&mut frame[8..12], self.layout_version);
        put_u64(&mut frame[16..24], self.capabilities);
        put_u64(&mut frame[24..32], self.counter_count);
        frame
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        let frame = decode_frame::<HELLO_FRAME_SIZE>(bytes, FRAME_HELLO)?;
        Self::decode_validated(&frame)
    }

    pub fn read_from(reader: &mut impl Read) -> io::Result<Self> {
        let frame = read_frame::<HELLO_FRAME_SIZE>(reader, FRAME_HELLO)?;
        Self::decode_validated(&frame)
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.encode())
    }

    fn decode_validated(frame: &[u8; HELLO_FRAME_SIZE]) -> io::Result<Self> {
        require_zero("Hello reserved field", &frame[12..16])?;
        let layout_version = get_u32(&frame[8..12]);
        if layout_version != SHM_LAYOUT_VERSION {
            return Err(invalid_data(format!(
                "unsupported shared-memory layout version {layout_version}; expected {SHM_LAYOUT_VERSION}"
            )));
        }
        Ok(Self {
            layout_version,
            capabilities: get_u64(&frame[16..24]),
            counter_count: get_u64(&frame[24..32]),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunFrame {
    pub run_id: u64,
    pub input_size: u64,
}

impl RunFrame {
    pub fn encode(&self) -> [u8; RUN_FRAME_SIZE] {
        let mut frame = initialized_frame::<RUN_FRAME_SIZE>(FRAME_RUN);
        put_u64(&mut frame[8..16], self.run_id);
        put_u64(&mut frame[16..24], self.input_size);
        frame
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        let frame = decode_frame::<RUN_FRAME_SIZE>(bytes, FRAME_RUN)?;
        Ok(Self::decode_validated(&frame))
    }

    pub fn read_from(reader: &mut impl Read) -> io::Result<Self> {
        let frame = read_frame::<RUN_FRAME_SIZE>(reader, FRAME_RUN)?;
        Ok(Self::decode_validated(&frame))
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.encode())
    }

    fn decode_validated(frame: &[u8; RUN_FRAME_SIZE]) -> Self {
        Self {
            run_id: get_u64(&frame[8..16]),
            input_size: get_u64(&frame[16..24]),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StopFrame {
    pub reason: u32,
}

impl StopFrame {
    pub fn encode(&self) -> [u8; STOP_FRAME_SIZE] {
        let mut frame = initialized_frame::<STOP_FRAME_SIZE>(FRAME_STOP);
        put_u32(&mut frame[8..12], self.reason);
        frame
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        let frame = decode_frame::<STOP_FRAME_SIZE>(bytes, FRAME_STOP)?;
        Self::decode_validated(&frame)
    }

    pub fn read_from(reader: &mut impl Read) -> io::Result<Self> {
        let frame = read_frame::<STOP_FRAME_SIZE>(reader, FRAME_STOP)?;
        Self::decode_validated(&frame)
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.encode())
    }

    fn decode_validated(frame: &[u8; STOP_FRAME_SIZE]) -> io::Result<Self> {
        require_zero("Stop reserved field", &frame[12..16])?;
        Ok(Self {
            reason: get_u32(&frame[8..12]),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DoneFrame {
    pub run_id: u64,
    pub status: u32,
    pub harness_return: i32,
    pub feature_count: u32,
    pub cmp_count: u32,
    pub done_flags: u32,
}

impl DoneFrame {
    pub fn encode(&self) -> [u8; DONE_FRAME_SIZE] {
        let mut frame = initialized_frame::<DONE_FRAME_SIZE>(FRAME_DONE);
        put_u64(&mut frame[8..16], self.run_id);
        put_u32(&mut frame[16..20], self.status);
        frame[20..24].copy_from_slice(&self.harness_return.to_le_bytes());
        put_u32(&mut frame[24..28], self.feature_count);
        put_u32(&mut frame[28..32], self.cmp_count);
        put_u32(&mut frame[32..36], self.done_flags);
        frame
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        let frame = decode_frame::<DONE_FRAME_SIZE>(bytes, FRAME_DONE)?;
        Self::decode_validated(&frame)
    }

    pub fn read_from(reader: &mut impl Read) -> io::Result<Self> {
        let frame = read_frame::<DONE_FRAME_SIZE>(reader, FRAME_DONE)?;
        Self::decode_validated(&frame)
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.encode())
    }

    fn decode_validated(frame: &[u8; DONE_FRAME_SIZE]) -> io::Result<Self> {
        require_zero("Done reserved field", &frame[36..40])?;
        Ok(Self {
            run_id: get_u64(&frame[8..16]),
            status: get_u32(&frame[16..20]),
            harness_return: i32::from_le_bytes(frame[20..24].try_into().expect("fixed slice")),
            feature_count: get_u32(&frame[24..28]),
            cmp_count: get_u32(&frame[28..32]),
            done_flags: get_u32(&frame[32..36]),
        })
    }
}

fn initialized_frame<const SIZE: usize>(frame_type: u8) -> [u8; SIZE] {
    debug_assert!(SIZE >= FRAME_HEADER_SIZE);
    debug_assert!(u32::try_from(SIZE).is_ok());
    let mut frame = [0; SIZE];
    put_u32(&mut frame[0..4], SIZE as u32);
    frame[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    frame[6] = frame_type;
    frame
}

fn decode_frame<const SIZE: usize>(bytes: &[u8], frame_type: u8) -> io::Result<[u8; SIZE]> {
    if bytes.len() != SIZE {
        return Err(invalid_data(format!(
            "frame buffer has {} bytes; expected {SIZE}",
            bytes.len()
        )));
    }
    validate_header(bytes, SIZE, frame_type)?;
    let mut frame = [0; SIZE];
    frame.copy_from_slice(bytes);
    Ok(frame)
}

fn read_frame<const SIZE: usize>(reader: &mut impl Read, frame_type: u8) -> io::Result<[u8; SIZE]> {
    let mut frame = [0; SIZE];
    reader.read_exact(&mut frame[..FRAME_HEADER_SIZE])?;
    validate_header(&frame[..FRAME_HEADER_SIZE], SIZE, frame_type)?;
    reader.read_exact(&mut frame[FRAME_HEADER_SIZE..])?;
    Ok(frame)
}

fn validate_header(bytes: &[u8], expected_size: usize, expected_type: u8) -> io::Result<()> {
    if bytes.len() < FRAME_HEADER_SIZE {
        return Err(invalid_data("truncated frame header"));
    }

    let size = get_u32(&bytes[0..4]);
    if size != expected_size as u32 {
        return Err(invalid_data(format!(
            "frame declares size {size}; expected {expected_size}"
        )));
    }

    let version = get_u16(&bytes[4..6]);
    if version != PROTOCOL_VERSION {
        return Err(invalid_data(format!(
            "unsupported protocol version {version}; expected {PROTOCOL_VERSION}"
        )));
    }

    let frame_type = bytes[6];
    if frame_type != expected_type {
        return Err(invalid_data(format!(
            "frame has type {frame_type}; expected {expected_type}"
        )));
    }

    if bytes[7] != 0 {
        return Err(invalid_data(format!(
            "unsupported frame flags {:#04x}",
            bytes[7]
        )));
    }
    Ok(())
}

fn require_zero(name: &str, bytes: &[u8]) -> io::Result<()> {
    if bytes.iter().any(|byte| *byte != 0) {
        return Err(invalid_data(format!("{name} is nonzero")));
    }
    Ok(())
}

fn get_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("two-byte field"))
}

fn get_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte field"))
}

fn get_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("eight-byte field"))
}

fn put_u32(bytes: &mut [u8], value: u32) {
    bytes.copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], value: u64) {
    bytes.copy_from_slice(&value.to_le_bytes());
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_round_trip_with_little_endian_layout() {
        let hello = HelloFrame {
            layout_version: SHM_LAYOUT_VERSION,
            capabilities: CAP_INLINE_8BIT_COUNTERS | CAP_PC_TABLE | CAP_TRACE_CMP,
            counter_count: 0x0102_0304_0506_0708,
        };
        let hello_bytes = hello.encode();
        assert_eq!(&hello_bytes[0..8], &[32, 0, 0, 0, 1, 0, FRAME_HELLO, 0]);
        assert_eq!(&hello_bytes[8..12], &[1, 0, 0, 0]);
        assert_eq!(&hello_bytes[24..32], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(HelloFrame::decode(&hello_bytes).unwrap(), hello);

        let run = RunFrame {
            run_id: 0x8877_6655_4433_2211,
            input_size: 0x1020_3040_5060_7080,
        };
        assert_eq!(RunFrame::decode(&run.encode()).unwrap(), run);

        let stop = StopFrame {
            reason: 0xaabb_ccdd,
        };
        assert_eq!(StopFrame::decode(&stop.encode()).unwrap(), stop);

        let done = DoneFrame {
            run_id: 91,
            status: DONE_HARNESS_NONZERO,
            harness_return: -17,
            feature_count: 123,
            cmp_count: 456,
            done_flags: DONE_FEATURES_TRUNCATED | DONE_COMPARISONS_TRUNCATED,
        };
        assert_eq!(DoneFrame::decode(&done.encode()).unwrap(), done);
    }

    #[test]
    fn stream_methods_encode_and_decode_every_frame() {
        let hello = HelloFrame {
            layout_version: SHM_LAYOUT_VERSION,
            capabilities: CAP_TRACE_CMP,
            counter_count: 7,
        };
        let run = RunFrame {
            run_id: 10,
            input_size: 20,
        };
        let stop = StopFrame { reason: 30 };
        let done = DoneFrame {
            run_id: 10,
            status: DONE_OK,
            harness_return: 0,
            feature_count: 2,
            cmp_count: 3,
            done_flags: 0,
        };

        let mut wire = Vec::new();
        hello.write_to(&mut wire).unwrap();
        run.write_to(&mut wire).unwrap();
        stop.write_to(&mut wire).unwrap();
        done.write_to(&mut wire).unwrap();

        let mut cursor = Cursor::new(wire);
        assert_eq!(HelloFrame::read_from(&mut cursor).unwrap(), hello);
        assert_eq!(RunFrame::read_from(&mut cursor).unwrap(), run);
        assert_eq!(StopFrame::read_from(&mut cursor).unwrap(), stop);
        assert_eq!(DoneFrame::read_from(&mut cursor).unwrap(), done);
    }

    #[test]
    fn rejects_wrong_size_version_type_and_header_flags() {
        let original = RunFrame {
            run_id: 1,
            input_size: 2,
        }
        .encode();

        for (index, value) in [(0, 23), (4, 2), (6, FRAME_DONE), (7, 1)] {
            let mut malformed = original;
            malformed[index] = value;
            let error = RunFrame::decode(&malformed).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn rejects_wrong_buffer_length_before_decoding() {
        let bytes = RunFrame {
            run_id: 1,
            input_size: 2,
        }
        .encode();
        let error = RunFrame::decode(&bytes[..bytes.len() - 1]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_unknown_layout_and_nonzero_reserved_fields() {
        let mut hello = HelloFrame {
            layout_version: SHM_LAYOUT_VERSION,
            capabilities: 0,
            counter_count: 0,
        }
        .encode();
        hello[8] = 2;
        assert_eq!(
            HelloFrame::decode(&hello).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let mut done = DoneFrame {
            run_id: 0,
            status: DONE_OK,
            harness_return: 0,
            feature_count: 0,
            cmp_count: 0,
            done_flags: 0,
        }
        .encode();
        done[39] = 1;
        assert_eq!(
            DoneFrame::decode(&done).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn stream_reader_rejects_bad_header_without_reading_a_body() {
        let mut bytes = RunFrame {
            run_id: 1,
            input_size: 2,
        }
        .encode();
        bytes[7] = 0x80;
        let mut cursor = Cursor::new(bytes);
        let error = RunFrame::read_from(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(cursor.position(), FRAME_HEADER_SIZE as u64);
    }

    #[test]
    fn cmp_kind_rejects_unknown_values() {
        assert_eq!(CmpKind::from_raw(CMP_CONST).unwrap(), CmpKind::Const);
        assert_eq!(CmpKind::Const.as_raw(), CMP_CONST);
        assert_eq!(
            CmpKind::from_raw(255).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
