// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Vector operations: the context-free Core operators on `v128`, and the
//! lane transformations behind the vector loads and stores.
//!
//! A `v128` is its sixteen little-endian bytes; every operation decodes the
//! lanes it needs, computes, and encodes the result. Relaxed operations take
//! the deterministic profile's choice.

use crate::ir::{Immediate, Operation};
use crate::opcode::CoreOpcode;

use super::numeric::{Operands, fmax, fmin, trunc_sat_i32_s, trunc_sat_i32_u};
use super::{Fault, Value};

/// A lane type: how it is encoded and how a comparison mask of its width is
/// spelled.
pub(super) trait Lane: Copy {
    const SIZE: usize;
    fn decode(bytes: &[u8]) -> Self;
    fn encode(self, bytes: &mut [u8]);
    fn mask(bit: bool) -> Self;
}

macro_rules! integer_lane {
    ($t:ty, $size:expr) => {
        impl Lane for $t {
            const SIZE: usize = $size;
            fn decode(bytes: &[u8]) -> Self {
                <$t>::from_le_bytes(bytes.try_into().expect("lane width"))
            }
            fn encode(self, bytes: &mut [u8]) {
                bytes.copy_from_slice(&self.to_le_bytes());
            }
            fn mask(bit: bool) -> Self {
                if bit { !0 } else { 0 }
            }
        }
    };
}

integer_lane!(i8, 1);
integer_lane!(u8, 1);
integer_lane!(i16, 2);
integer_lane!(u16, 2);
integer_lane!(i32, 4);
integer_lane!(u32, 4);
integer_lane!(i64, 8);
integer_lane!(u64, 8);

macro_rules! float_lane {
    ($t:ty, $size:expr) => {
        impl Lane for $t {
            const SIZE: usize = $size;
            fn decode(bytes: &[u8]) -> Self {
                <$t>::from_le_bytes(bytes.try_into().expect("lane width"))
            }
            fn encode(self, bytes: &mut [u8]) {
                bytes.copy_from_slice(&self.to_le_bytes());
            }
            fn mask(_bit: bool) -> Self {
                unreachable!("float lanes never carry comparison masks")
            }
        }
    };
}

float_lane!(f32, 4);
float_lane!(f64, 8);

pub(super) fn lanes<T: Lane, const N: usize>(bytes: &[u8; 16]) -> [T; N] {
    std::array::from_fn(|index| T::decode(&bytes[index * T::SIZE..][..T::SIZE]))
}

pub(super) fn pack<T: Lane, const N: usize>(lanes: [T; N]) -> [u8; 16] {
    let mut bytes = [0; 16];
    for (index, lane) in lanes.into_iter().enumerate() {
        lane.encode(&mut bytes[index * T::SIZE..][..T::SIZE]);
    }
    bytes
}

fn unary<T: Lane, const N: usize>(a: [u8; 16], f: impl Fn(T) -> T) -> [u8; 16] {
    pack(lanes::<T, N>(&a).map(f))
}

fn binary<T: Lane, const N: usize>(a: [u8; 16], b: [u8; 16], f: impl Fn(T, T) -> T) -> [u8; 16] {
    let (a, b) = (lanes::<T, N>(&a), lanes::<T, N>(&b));
    pack(std::array::from_fn::<T, N, _>(|index| {
        f(a[index], b[index])
    }))
}

fn ternary<T: Lane, const N: usize>(
    a: [u8; 16],
    b: [u8; 16],
    c: [u8; 16],
    f: impl Fn(T, T, T) -> T,
) -> [u8; 16] {
    let (a, b, c) = (lanes::<T, N>(&a), lanes::<T, N>(&b), lanes::<T, N>(&c));
    pack(std::array::from_fn::<T, N, _>(|index| {
        f(a[index], b[index], c[index])
    }))
}

/// Compares lane-wise, producing a mask in `M`, the integer lane of the
/// same width as `T`.
fn compare<T: Lane, M: Lane, const N: usize>(
    a: [u8; 16],
    b: [u8; 16],
    f: impl Fn(T, T) -> bool,
) -> [u8; 16] {
    let (a, b) = (lanes::<T, N>(&a), lanes::<T, N>(&b));
    pack(std::array::from_fn::<M, N, _>(|index| {
        M::mask(f(a[index], b[index]))
    }))
}

/// Shifts every lane by the count modulo the lane width.
fn shift<T: Lane, const N: usize>(a: [u8; 16], count: u32, f: impl Fn(T, u32) -> T) -> [u8; 16] {
    let count = count % (T::SIZE as u32 * 8);
    unary::<T, N>(a, |lane| f(lane, count))
}

fn all_true<T: Lane + PartialEq + Default, const N: usize>(a: [u8; 16]) -> Value {
    Value::I32(u32::from(
        lanes::<T, N>(&a).iter().all(|lane| *lane != T::default()),
    ))
}

fn bitmask<T: Lane + Into<i64>, const N: usize>(a: [u8; 16]) -> Value {
    let mask = lanes::<T, N>(&a)
        .iter()
        .enumerate()
        .fold(0_u32, |mask, (index, lane)| {
            mask | (u32::from((*lane).into() < 0) << index)
        });
    Value::I32(mask)
}

/// Narrows the lanes of `a` then `b` into half-width lanes with saturation.
fn narrow<W: Lane, T: Lane, const WIDE: usize, const NARROW: usize>(
    a: [u8; 16],
    b: [u8; 16],
    saturate: impl Fn(W) -> T,
) -> [u8; 16] {
    let (a, b) = (lanes::<W, WIDE>(&a), lanes::<W, WIDE>(&b));
    pack(std::array::from_fn::<T, NARROW, _>(|index| {
        if index < WIDE {
            saturate(a[index])
        } else {
            saturate(b[index - WIDE])
        }
    }))
}

/// Widens the low or high half of `a`'s lanes.
fn extend<T: Lane, W: Lane, const NARROW: usize, const WIDE: usize>(
    a: [u8; 16],
    high: bool,
    widen: impl Fn(T) -> W,
) -> [u8; 16] {
    let a = lanes::<T, NARROW>(&a);
    let base = if high { WIDE } else { 0 };
    pack(std::array::from_fn::<W, WIDE, _>(|index| {
        widen(a[base + index])
    }))
}

/// Multiplies the low or high halves of `a` and `b` lane-wise into wider
/// lanes.
fn extended_multiply<T: Lane, W: Lane, const NARROW: usize, const WIDE: usize>(
    a: [u8; 16],
    b: [u8; 16],
    high: bool,
    widen: impl Fn(T) -> W,
    multiply: impl Fn(W, W) -> W,
) -> [u8; 16] {
    let (a, b) = (lanes::<T, NARROW>(&a), lanes::<T, NARROW>(&b));
    let base = if high { WIDE } else { 0 };
    pack(std::array::from_fn::<W, WIDE, _>(|index| {
        multiply(widen(a[base + index]), widen(b[base + index]))
    }))
}

/// Adds adjacent lane pairs into wider lanes.
fn extended_pairwise_add<T: Lane, W: Lane, const NARROW: usize, const WIDE: usize>(
    a: [u8; 16],
    widen: impl Fn(T) -> W,
    add: impl Fn(W, W) -> W,
) -> [u8; 16] {
    let a = lanes::<T, NARROW>(&a);
    pack(std::array::from_fn::<W, WIDE, _>(|index| {
        add(widen(a[2 * index]), widen(a[2 * index + 1]))
    }))
}

fn average_u8(a: u8, b: u8) -> u8 {
    ((u16::from(a) + u16::from(b) + 1) >> 1) as u8
}

fn average_u16(a: u16, b: u16) -> u16 {
    ((u32::from(a) + u32::from(b) + 1) >> 1) as u16
}

fn q15_multiply_round_saturate(a: i16, b: i16) -> i16 {
    ((i32::from(a) * i32::from(b) + 0x4000) >> 15).clamp(i32::from(i16::MIN), i32::from(i16::MAX))
        as i16
}

/// `i32x4.dot_i16x8_s`: adjacent products summed, wrapping.
fn dot_i16x8(a: [u8; 16], b: [u8; 16]) -> [u8; 16] {
    let (a, b) = (lanes::<i16, 8>(&a), lanes::<i16, 8>(&b));
    pack(std::array::from_fn::<i32, 4, _>(|index| {
        (i32::from(a[2 * index]) * i32::from(b[2 * index]))
            .wrapping_add(i32::from(a[2 * index + 1]) * i32::from(b[2 * index + 1]))
    }))
}

/// `i16x8.relaxed_dot_i8x16_i7x16_s` in the deterministic profile: signed
/// eight-bit lanes on both sides, adjacent products summed without
/// saturation.
fn relaxed_dot_i8x16(a: [u8; 16], b: [u8; 16]) -> [u8; 16] {
    let (a, b) = (lanes::<i8, 16>(&a), lanes::<i8, 16>(&b));
    pack(std::array::from_fn::<i16, 8, _>(|index| {
        (i16::from(a[2 * index]) * i16::from(b[2 * index]))
            .wrapping_add(i16::from(a[2 * index + 1]) * i16::from(b[2 * index + 1]))
    }))
}

fn pmin<T: PartialOrd>(a: T, b: T) -> T {
    if b < a { b } else { a }
}

fn pmax<T: PartialOrd>(a: T, b: T) -> T {
    if a < b { b } else { a }
}

fn swizzle(a: [u8; 16], indices: [u8; 16]) -> [u8; 16] {
    std::array::from_fn(|lane| a.get(usize::from(indices[lane])).copied().unwrap_or(0))
}

fn lane_index(operation: &Operation, index: usize) -> Result<usize, Fault> {
    match operation.immediates.get(index) {
        Some(Immediate::Lane(lane)) => Ok(usize::from(*lane)),
        other => Err(Fault::Invalid(format!(
            "{} needs a lane immediate at {index}, found {other:?}",
            operation.mnemonic()
        ))),
    }
}

fn shuffle_lanes(operation: &Operation) -> Result<[u8; 16], Fault> {
    match operation.immediates.first() {
        Some(Immediate::Bytes(bytes)) if bytes.len() == 16 => {
            Ok(bytes.as_slice().try_into().expect("sixteen bytes"))
        }
        other => Err(Fault::Invalid(format!(
            "{} needs sixteen lane indices, found {other:?}",
            operation.mnemonic()
        ))),
    }
}

fn extract<T: Lane, const N: usize>(a: [u8; 16], lane: usize) -> Result<T, Fault> {
    lanes::<T, N>(&a)
        .get(lane)
        .copied()
        .ok_or_else(|| Fault::Invalid(format!("lane {lane} is out of range")))
}

fn replace<T: Lane, const N: usize>(a: [u8; 16], lane: usize, value: T) -> Result<[u8; 16], Fault> {
    let mut lanes = lanes::<T, N>(&a);
    let slot = lanes
        .get_mut(lane)
        .ok_or_else(|| Fault::Invalid(format!("lane {lane} is out of range")))?;
    *slot = value;
    Ok(pack(lanes))
}

/// The vector produced by a `v128.loadNxM_s/u`: `bytes` widened lane by
/// lane.
pub(super) fn load_extend(opcode: CoreOpcode, bytes: [u8; 8]) -> [u8; 16] {
    use CoreOpcode::*;
    let mut wide = [0; 16];
    wide[..8].copy_from_slice(&bytes);
    match opcode {
        V128Load8x8S => extend::<i8, i16, 16, 8>(wide, false, i16::from),
        V128Load8x8U => extend::<u8, u16, 16, 8>(wide, false, u16::from),
        V128Load16x4S => extend::<i16, i32, 8, 4>(wide, false, i32::from),
        V128Load16x4U => extend::<u16, u32, 8, 4>(wide, false, u32::from),
        V128Load32x2S => extend::<i32, i64, 4, 2>(wide, false, i64::from),
        V128Load32x2U => extend::<u32, u64, 4, 2>(wide, false, u64::from),
        _ => unreachable!("not an extending load"),
    }
}

/// `bytes` repeated across the vector.
pub(super) fn splat_bytes(bytes: &[u8]) -> [u8; 16] {
    let mut vector = [0; 16];
    for chunk in vector.chunks_mut(bytes.len()) {
        chunk.copy_from_slice(bytes);
    }
    vector
}

/// `bytes` in the low lanes and zeros above.
pub(super) fn zero_extend_bytes(bytes: &[u8]) -> [u8; 16] {
    let mut vector = [0; 16];
    vector[..bytes.len()].copy_from_slice(bytes);
    vector
}

/// `vector` with lane `lane` of width `bytes.len()` replaced by `bytes`.
pub(super) fn replace_lane_bytes(
    vector: [u8; 16],
    lane: usize,
    bytes: &[u8],
) -> Result<[u8; 16], Fault> {
    let mut vector = vector;
    let start = lane * bytes.len();
    vector
        .get_mut(start..start + bytes.len())
        .ok_or_else(|| Fault::Invalid(format!("lane {lane} is out of range")))?
        .copy_from_slice(bytes);
    Ok(vector)
}

/// The bytes of lane `lane` of width `width`.
pub(super) fn lane_bytes(vector: &[u8; 16], lane: usize, width: usize) -> Result<&[u8], Fault> {
    vector
        .get(lane * width..(lane + 1) * width)
        .ok_or_else(|| Fault::Invalid(format!("lane {lane} is out of range")))
}

/// Executes a context-free vector `opcode` on `operands`, or returns `None`
/// when the opcode is not one.
pub(super) fn execute(
    opcode: CoreOpcode,
    operation: &Operation,
    a: &Operands<'_>,
) -> Result<Option<Value>, Fault> {
    use CoreOpcode::*;
    let v = |index| a.v128(index);
    let lane = |index| lane_index(operation, index);

    let vector = match opcode {
        I8x16Shuffle => {
            let indices = shuffle_lanes(operation)?;
            let (x, y) = (v(0)?, v(1)?);
            std::array::from_fn(|lane| {
                let index = usize::from(indices[lane]);
                if index < 16 { x[index] } else { y[index - 16] }
            })
        }
        I8x16Swizzle | I8x16RelaxedSwizzle => swizzle(v(0)?, v(1)?),
        I8x16Splat => splat_bytes(&[a.i32(0)? as u8]),
        I16x8Splat => splat_bytes(&(a.i32(0)? as u16).to_le_bytes()),
        I32x4Splat => splat_bytes(&a.i32(0)?.to_le_bytes()),
        I64x2Splat => splat_bytes(&a.i64(0)?.to_le_bytes()),
        F32x4Splat => splat_bytes(&a.f32(0)?.to_le_bytes()),
        F64x2Splat => splat_bytes(&a.f64(0)?.to_le_bytes()),
        I8x16ExtractLaneS => {
            return Ok(Some(Value::I32(
                extract::<i8, 16>(v(0)?, lane(0)?)? as i32 as u32
            )));
        }
        I8x16ExtractLaneU => {
            return Ok(Some(Value::I32(u32::from(extract::<u8, 16>(
                v(0)?,
                lane(0)?,
            )?))));
        }
        I16x8ExtractLaneS => {
            return Ok(Some(Value::I32(
                extract::<i16, 8>(v(0)?, lane(0)?)? as i32 as u32
            )));
        }
        I16x8ExtractLaneU => {
            return Ok(Some(Value::I32(u32::from(extract::<u16, 8>(
                v(0)?,
                lane(0)?,
            )?))));
        }
        I32x4ExtractLane => return Ok(Some(Value::I32(extract::<u32, 4>(v(0)?, lane(0)?)?))),
        I64x2ExtractLane => return Ok(Some(Value::I64(extract::<u64, 2>(v(0)?, lane(0)?)?))),
        F32x4ExtractLane => return Ok(Some(Value::f32(extract::<f32, 4>(v(0)?, lane(0)?)?))),
        F64x2ExtractLane => return Ok(Some(Value::f64(extract::<f64, 2>(v(0)?, lane(0)?)?))),
        I8x16ReplaceLane => replace::<u8, 16>(v(0)?, lane(0)?, a.i32(1)? as u8)?,
        I16x8ReplaceLane => replace::<u16, 8>(v(0)?, lane(0)?, a.i32(1)? as u16)?,
        I32x4ReplaceLane => replace::<u32, 4>(v(0)?, lane(0)?, a.i32(1)?)?,
        I64x2ReplaceLane => replace::<u64, 2>(v(0)?, lane(0)?, a.i64(1)?)?,
        F32x4ReplaceLane => replace::<f32, 4>(v(0)?, lane(0)?, a.f32(1)?)?,
        F64x2ReplaceLane => replace::<f64, 2>(v(0)?, lane(0)?, a.f64(1)?)?,

        I8x16Eq => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x == y),
        I8x16Ne => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x != y),
        I8x16LtS => compare::<i8, u8, 16>(v(0)?, v(1)?, |x, y| x < y),
        I8x16LtU => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x < y),
        I8x16GtS => compare::<i8, u8, 16>(v(0)?, v(1)?, |x, y| x > y),
        I8x16GtU => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x > y),
        I8x16LeS => compare::<i8, u8, 16>(v(0)?, v(1)?, |x, y| x <= y),
        I8x16LeU => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x <= y),
        I8x16GeS => compare::<i8, u8, 16>(v(0)?, v(1)?, |x, y| x >= y),
        I8x16GeU => compare::<u8, u8, 16>(v(0)?, v(1)?, |x, y| x >= y),
        I16x8Eq => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x == y),
        I16x8Ne => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x != y),
        I16x8LtS => compare::<i16, u16, 8>(v(0)?, v(1)?, |x, y| x < y),
        I16x8LtU => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x < y),
        I16x8GtS => compare::<i16, u16, 8>(v(0)?, v(1)?, |x, y| x > y),
        I16x8GtU => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x > y),
        I16x8LeS => compare::<i16, u16, 8>(v(0)?, v(1)?, |x, y| x <= y),
        I16x8LeU => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x <= y),
        I16x8GeS => compare::<i16, u16, 8>(v(0)?, v(1)?, |x, y| x >= y),
        I16x8GeU => compare::<u16, u16, 8>(v(0)?, v(1)?, |x, y| x >= y),
        I32x4Eq => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x == y),
        I32x4Ne => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x != y),
        I32x4LtS => compare::<i32, u32, 4>(v(0)?, v(1)?, |x, y| x < y),
        I32x4LtU => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x < y),
        I32x4GtS => compare::<i32, u32, 4>(v(0)?, v(1)?, |x, y| x > y),
        I32x4GtU => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x > y),
        I32x4LeS => compare::<i32, u32, 4>(v(0)?, v(1)?, |x, y| x <= y),
        I32x4LeU => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x <= y),
        I32x4GeS => compare::<i32, u32, 4>(v(0)?, v(1)?, |x, y| x >= y),
        I32x4GeU => compare::<u32, u32, 4>(v(0)?, v(1)?, |x, y| x >= y),
        I64x2Eq => compare::<u64, u64, 2>(v(0)?, v(1)?, |x, y| x == y),
        I64x2Ne => compare::<u64, u64, 2>(v(0)?, v(1)?, |x, y| x != y),
        I64x2LtS => compare::<i64, u64, 2>(v(0)?, v(1)?, |x, y| x < y),
        I64x2GtS => compare::<i64, u64, 2>(v(0)?, v(1)?, |x, y| x > y),
        I64x2LeS => compare::<i64, u64, 2>(v(0)?, v(1)?, |x, y| x <= y),
        I64x2GeS => compare::<i64, u64, 2>(v(0)?, v(1)?, |x, y| x >= y),
        F32x4Eq => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x == y),
        F32x4Ne => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x != y),
        F32x4Lt => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x < y),
        F32x4Gt => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x > y),
        F32x4Le => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x <= y),
        F32x4Ge => compare::<f32, u32, 4>(v(0)?, v(1)?, |x, y| x >= y),
        F64x2Eq => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x == y),
        F64x2Ne => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x != y),
        F64x2Lt => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x < y),
        F64x2Gt => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x > y),
        F64x2Le => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x <= y),
        F64x2Ge => compare::<f64, u64, 2>(v(0)?, v(1)?, |x, y| x >= y),

        V128Not => v(0)?.map(|byte| !byte),
        V128And => binary::<u8, 16>(v(0)?, v(1)?, |x, y| x & y),
        V128AndNot => binary::<u8, 16>(v(0)?, v(1)?, |x, y| x & !y),
        V128Or => binary::<u8, 16>(v(0)?, v(1)?, |x, y| x | y),
        V128Xor => binary::<u8, 16>(v(0)?, v(1)?, |x, y| x ^ y),
        V128Bitselect
        | I8x16RelaxedLaneselect
        | I16x8RelaxedLaneselect
        | I32x4RelaxedLaneselect
        | I64x2RelaxedLaneselect => {
            ternary::<u8, 16>(v(0)?, v(1)?, v(2)?, |x, y, mask| (x & mask) | (y & !mask))
        }
        V128AnyTrue => {
            return Ok(Some(Value::I32(u32::from(
                v(0)?.iter().any(|byte| *byte != 0),
            ))));
        }

        I8x16Abs => unary::<i8, 16>(v(0)?, i8::wrapping_abs),
        I8x16Neg => unary::<i8, 16>(v(0)?, i8::wrapping_neg),
        I8x16Popcnt => unary::<u8, 16>(v(0)?, |x| x.count_ones() as u8),
        I8x16AllTrue => return Ok(Some(all_true::<u8, 16>(v(0)?))),
        I8x16Bitmask => return Ok(Some(bitmask::<i8, 16>(v(0)?))),
        I8x16NarrowI16x8S => narrow::<i16, i8, 8, 16>(v(0)?, v(1)?, |x| {
            x.clamp(i16::from(i8::MIN), i16::from(i8::MAX)) as i8
        }),
        I8x16NarrowI16x8U => narrow::<i16, u8, 8, 16>(v(0)?, v(1)?, |x| x.clamp(0, 255) as u8),
        I8x16Shl => shift::<u8, 16>(v(0)?, a.i32(1)?, |x, n| x << n),
        I8x16ShrS => shift::<i8, 16>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I8x16ShrU => shift::<u8, 16>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I8x16Add => binary::<u8, 16>(v(0)?, v(1)?, u8::wrapping_add),
        I8x16AddSatS => binary::<i8, 16>(v(0)?, v(1)?, i8::saturating_add),
        I8x16AddSatU => binary::<u8, 16>(v(0)?, v(1)?, u8::saturating_add),
        I8x16Sub => binary::<u8, 16>(v(0)?, v(1)?, u8::wrapping_sub),
        I8x16SubSatS => binary::<i8, 16>(v(0)?, v(1)?, i8::saturating_sub),
        I8x16SubSatU => binary::<u8, 16>(v(0)?, v(1)?, u8::saturating_sub),
        I8x16MinS => binary::<i8, 16>(v(0)?, v(1)?, i8::min),
        I8x16MinU => binary::<u8, 16>(v(0)?, v(1)?, u8::min),
        I8x16MaxS => binary::<i8, 16>(v(0)?, v(1)?, i8::max),
        I8x16MaxU => binary::<u8, 16>(v(0)?, v(1)?, u8::max),
        I8x16AvgrU => binary::<u8, 16>(v(0)?, v(1)?, average_u8),

        I16x8ExtAddPairwiseI8x16S => {
            extended_pairwise_add::<i8, i16, 16, 8>(v(0)?, i16::from, i16::wrapping_add)
        }
        I16x8ExtAddPairwiseI8x16U => {
            extended_pairwise_add::<u8, u16, 16, 8>(v(0)?, u16::from, u16::wrapping_add)
        }
        I16x8Abs => unary::<i16, 8>(v(0)?, i16::wrapping_abs),
        I16x8Neg => unary::<i16, 8>(v(0)?, i16::wrapping_neg),
        I16x8Q15MulrSatS | I16x8RelaxedQ15mulrS => {
            binary::<i16, 8>(v(0)?, v(1)?, q15_multiply_round_saturate)
        }
        I16x8AllTrue => return Ok(Some(all_true::<u16, 8>(v(0)?))),
        I16x8Bitmask => return Ok(Some(bitmask::<i16, 8>(v(0)?))),
        I16x8NarrowI32x4S => narrow::<i32, i16, 4, 8>(v(0)?, v(1)?, |x| {
            x.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16
        }),
        I16x8NarrowI32x4U => narrow::<i32, u16, 4, 8>(v(0)?, v(1)?, |x| x.clamp(0, 65535) as u16),
        I16x8ExtendLowI8x16S => extend::<i8, i16, 16, 8>(v(0)?, false, i16::from),
        I16x8ExtendHighI8x16S => extend::<i8, i16, 16, 8>(v(0)?, true, i16::from),
        I16x8ExtendLowI8x16U => extend::<u8, u16, 16, 8>(v(0)?, false, u16::from),
        I16x8ExtendHighI8x16U => extend::<u8, u16, 16, 8>(v(0)?, true, u16::from),
        I16x8Shl => shift::<u16, 8>(v(0)?, a.i32(1)?, |x, n| x << n),
        I16x8ShrS => shift::<i16, 8>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I16x8ShrU => shift::<u16, 8>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I16x8Add => binary::<u16, 8>(v(0)?, v(1)?, u16::wrapping_add),
        I16x8AddSatS => binary::<i16, 8>(v(0)?, v(1)?, i16::saturating_add),
        I16x8AddSatU => binary::<u16, 8>(v(0)?, v(1)?, u16::saturating_add),
        I16x8Sub => binary::<u16, 8>(v(0)?, v(1)?, u16::wrapping_sub),
        I16x8SubSatS => binary::<i16, 8>(v(0)?, v(1)?, i16::saturating_sub),
        I16x8SubSatU => binary::<u16, 8>(v(0)?, v(1)?, u16::saturating_sub),
        I16x8Mul => binary::<u16, 8>(v(0)?, v(1)?, u16::wrapping_mul),
        I16x8MinS => binary::<i16, 8>(v(0)?, v(1)?, i16::min),
        I16x8MinU => binary::<u16, 8>(v(0)?, v(1)?, u16::min),
        I16x8MaxS => binary::<i16, 8>(v(0)?, v(1)?, i16::max),
        I16x8MaxU => binary::<u16, 8>(v(0)?, v(1)?, u16::max),
        I16x8AvgrU => binary::<u16, 8>(v(0)?, v(1)?, average_u16),
        I16x8ExtMulLowI8x16S => {
            extended_multiply::<i8, i16, 16, 8>(v(0)?, v(1)?, false, i16::from, i16::wrapping_mul)
        }
        I16x8ExtMulHighI8x16S => {
            extended_multiply::<i8, i16, 16, 8>(v(0)?, v(1)?, true, i16::from, i16::wrapping_mul)
        }
        I16x8ExtMulLowI8x16U => {
            extended_multiply::<u8, u16, 16, 8>(v(0)?, v(1)?, false, u16::from, u16::wrapping_mul)
        }
        I16x8ExtMulHighI8x16U => {
            extended_multiply::<u8, u16, 16, 8>(v(0)?, v(1)?, true, u16::from, u16::wrapping_mul)
        }

        I32x4ExtAddPairwiseI16x8S => {
            extended_pairwise_add::<i16, i32, 8, 4>(v(0)?, i32::from, i32::wrapping_add)
        }
        I32x4ExtAddPairwiseI16x8U => {
            extended_pairwise_add::<u16, u32, 8, 4>(v(0)?, u32::from, u32::wrapping_add)
        }
        I32x4Abs => unary::<i32, 4>(v(0)?, i32::wrapping_abs),
        I32x4Neg => unary::<i32, 4>(v(0)?, i32::wrapping_neg),
        I32x4AllTrue => return Ok(Some(all_true::<u32, 4>(v(0)?))),
        I32x4Bitmask => return Ok(Some(bitmask::<i32, 4>(v(0)?))),
        I32x4ExtendLowI16x8S => extend::<i16, i32, 8, 4>(v(0)?, false, i32::from),
        I32x4ExtendHighI16x8S => extend::<i16, i32, 8, 4>(v(0)?, true, i32::from),
        I32x4ExtendLowI16x8U => extend::<u16, u32, 8, 4>(v(0)?, false, u32::from),
        I32x4ExtendHighI16x8U => extend::<u16, u32, 8, 4>(v(0)?, true, u32::from),
        I32x4Shl => shift::<u32, 4>(v(0)?, a.i32(1)?, |x, n| x << n),
        I32x4ShrS => shift::<i32, 4>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I32x4ShrU => shift::<u32, 4>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I32x4Add => binary::<u32, 4>(v(0)?, v(1)?, u32::wrapping_add),
        I32x4Sub => binary::<u32, 4>(v(0)?, v(1)?, u32::wrapping_sub),
        I32x4Mul => binary::<u32, 4>(v(0)?, v(1)?, u32::wrapping_mul),
        I32x4MinS => binary::<i32, 4>(v(0)?, v(1)?, i32::min),
        I32x4MinU => binary::<u32, 4>(v(0)?, v(1)?, u32::min),
        I32x4MaxS => binary::<i32, 4>(v(0)?, v(1)?, i32::max),
        I32x4MaxU => binary::<u32, 4>(v(0)?, v(1)?, u32::max),
        I32x4DotI16x8S => dot_i16x8(v(0)?, v(1)?),
        I32x4ExtMulLowI16x8S => {
            extended_multiply::<i16, i32, 8, 4>(v(0)?, v(1)?, false, i32::from, i32::wrapping_mul)
        }
        I32x4ExtMulHighI16x8S => {
            extended_multiply::<i16, i32, 8, 4>(v(0)?, v(1)?, true, i32::from, i32::wrapping_mul)
        }
        I32x4ExtMulLowI16x8U => {
            extended_multiply::<u16, u32, 8, 4>(v(0)?, v(1)?, false, u32::from, u32::wrapping_mul)
        }
        I32x4ExtMulHighI16x8U => {
            extended_multiply::<u16, u32, 8, 4>(v(0)?, v(1)?, true, u32::from, u32::wrapping_mul)
        }

        I64x2Abs => unary::<i64, 2>(v(0)?, i64::wrapping_abs),
        I64x2Neg => unary::<i64, 2>(v(0)?, i64::wrapping_neg),
        I64x2AllTrue => return Ok(Some(all_true::<u64, 2>(v(0)?))),
        I64x2Bitmask => return Ok(Some(bitmask::<i64, 2>(v(0)?))),
        I64x2ExtendLowI32x4S => extend::<i32, i64, 4, 2>(v(0)?, false, i64::from),
        I64x2ExtendHighI32x4S => extend::<i32, i64, 4, 2>(v(0)?, true, i64::from),
        I64x2ExtendLowI32x4U => extend::<u32, u64, 4, 2>(v(0)?, false, u64::from),
        I64x2ExtendHighI32x4U => extend::<u32, u64, 4, 2>(v(0)?, true, u64::from),
        I64x2Shl => shift::<u64, 2>(v(0)?, a.i32(1)?, |x, n| x << n),
        I64x2ShrS => shift::<i64, 2>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I64x2ShrU => shift::<u64, 2>(v(0)?, a.i32(1)?, |x, n| x >> n),
        I64x2Add => binary::<u64, 2>(v(0)?, v(1)?, u64::wrapping_add),
        I64x2Sub => binary::<u64, 2>(v(0)?, v(1)?, u64::wrapping_sub),
        I64x2Mul => binary::<u64, 2>(v(0)?, v(1)?, u64::wrapping_mul),
        I64x2ExtMulLowI32x4S => {
            extended_multiply::<i32, i64, 4, 2>(v(0)?, v(1)?, false, i64::from, i64::wrapping_mul)
        }
        I64x2ExtMulHighI32x4S => {
            extended_multiply::<i32, i64, 4, 2>(v(0)?, v(1)?, true, i64::from, i64::wrapping_mul)
        }
        I64x2ExtMulLowI32x4U => {
            extended_multiply::<u32, u64, 4, 2>(v(0)?, v(1)?, false, u64::from, u64::wrapping_mul)
        }
        I64x2ExtMulHighI32x4U => {
            extended_multiply::<u32, u64, 4, 2>(v(0)?, v(1)?, true, u64::from, u64::wrapping_mul)
        }

        F32x4Ceil => unary::<f32, 4>(v(0)?, f32::ceil),
        F32x4Floor => unary::<f32, 4>(v(0)?, f32::floor),
        F32x4Trunc => unary::<f32, 4>(v(0)?, f32::trunc),
        F32x4Nearest => unary::<f32, 4>(v(0)?, f32::round_ties_even),
        F32x4Abs => unary::<f32, 4>(v(0)?, f32::abs),
        F32x4Neg => unary::<f32, 4>(v(0)?, |x| -x),
        F32x4Sqrt => unary::<f32, 4>(v(0)?, f32::sqrt),
        F32x4Add => binary::<f32, 4>(v(0)?, v(1)?, |x, y| x + y),
        F32x4Sub => binary::<f32, 4>(v(0)?, v(1)?, |x, y| x - y),
        F32x4Mul => binary::<f32, 4>(v(0)?, v(1)?, |x, y| x * y),
        F32x4Div => binary::<f32, 4>(v(0)?, v(1)?, |x, y| x / y),
        F32x4Min | F32x4RelaxedMin => binary::<f32, 4>(v(0)?, v(1)?, fmin),
        F32x4Max | F32x4RelaxedMax => binary::<f32, 4>(v(0)?, v(1)?, fmax),
        F32x4PMin => binary::<f32, 4>(v(0)?, v(1)?, pmin),
        F32x4PMax => binary::<f32, 4>(v(0)?, v(1)?, pmax),
        F64x2Ceil => unary::<f64, 2>(v(0)?, f64::ceil),
        F64x2Floor => unary::<f64, 2>(v(0)?, f64::floor),
        F64x2Trunc => unary::<f64, 2>(v(0)?, f64::trunc),
        F64x2Nearest => unary::<f64, 2>(v(0)?, f64::round_ties_even),
        F64x2Abs => unary::<f64, 2>(v(0)?, f64::abs),
        F64x2Neg => unary::<f64, 2>(v(0)?, |x| -x),
        F64x2Sqrt => unary::<f64, 2>(v(0)?, f64::sqrt),
        F64x2Add => binary::<f64, 2>(v(0)?, v(1)?, |x, y| x + y),
        F64x2Sub => binary::<f64, 2>(v(0)?, v(1)?, |x, y| x - y),
        F64x2Mul => binary::<f64, 2>(v(0)?, v(1)?, |x, y| x * y),
        F64x2Div => binary::<f64, 2>(v(0)?, v(1)?, |x, y| x / y),
        F64x2Min | F64x2RelaxedMin => binary::<f64, 2>(v(0)?, v(1)?, fmin),
        F64x2Max | F64x2RelaxedMax => binary::<f64, 2>(v(0)?, v(1)?, fmax),
        F64x2PMin => binary::<f64, 2>(v(0)?, v(1)?, pmin),
        F64x2PMax => binary::<f64, 2>(v(0)?, v(1)?, pmax),

        I32x4TruncSatF32x4S | I32x4RelaxedTruncF32x4S => {
            pack(lanes::<f32, 4>(&v(0)?).map(trunc_sat_i32_s))
        }
        I32x4TruncSatF32x4U | I32x4RelaxedTruncF32x4U => {
            pack(lanes::<f32, 4>(&v(0)?).map(trunc_sat_i32_u))
        }
        F32x4ConvertI32x4S => pack(lanes::<i32, 4>(&v(0)?).map(|x| x as f32)),
        F32x4ConvertI32x4U => pack(lanes::<u32, 4>(&v(0)?).map(|x| x as f32)),
        I32x4TruncSatF64x2SZero | I32x4RelaxedTruncF64x2SZero => {
            let low = lanes::<f64, 2>(&v(0)?).map(trunc_sat_i32_s);
            pack([low[0], low[1], 0, 0])
        }
        I32x4TruncSatF64x2UZero | I32x4RelaxedTruncF64x2UZero => {
            let low = lanes::<f64, 2>(&v(0)?).map(trunc_sat_i32_u);
            pack([low[0], low[1], 0, 0])
        }
        F64x2ConvertLowI32x4S => {
            let low = lanes::<i32, 4>(&v(0)?);
            pack([f64::from(low[0]), f64::from(low[1])])
        }
        F64x2ConvertLowI32x4U => {
            let low = lanes::<u32, 4>(&v(0)?);
            pack([f64::from(low[0]), f64::from(low[1])])
        }
        F32x4DemoteF64x2Zero => {
            let wide = lanes::<f64, 2>(&v(0)?);
            pack([wide[0] as f32, wide[1] as f32, 0.0, 0.0])
        }
        F64x2PromoteLowF32x4 => {
            let narrow = lanes::<f32, 4>(&v(0)?);
            pack([f64::from(narrow[0]), f64::from(narrow[1])])
        }

        F32x4RelaxedMadd => ternary::<f32, 4>(v(0)?, v(1)?, v(2)?, |x, y, z| x.mul_add(y, z)),
        F32x4RelaxedNmadd => ternary::<f32, 4>(v(0)?, v(1)?, v(2)?, |x, y, z| (-x).mul_add(y, z)),
        F64x2RelaxedMadd => ternary::<f64, 2>(v(0)?, v(1)?, v(2)?, |x, y, z| x.mul_add(y, z)),
        F64x2RelaxedNmadd => ternary::<f64, 2>(v(0)?, v(1)?, v(2)?, |x, y, z| (-x).mul_add(y, z)),
        I16x8RelaxedDotI8x16I7x16S => relaxed_dot_i8x16(v(0)?, v(1)?),
        I32x4RelaxedDotI8x16I7x16AddS => {
            let dot = relaxed_dot_i8x16(v(0)?, v(1)?);
            let widened =
                extended_pairwise_add::<i16, i32, 8, 4>(dot, i32::from, i32::wrapping_add);
            binary::<i32, 4>(widened, v(2)?, i32::wrapping_add)
        }

        _ => return Ok(None),
    };
    Ok(Some(Value::V128(vector)))
}
