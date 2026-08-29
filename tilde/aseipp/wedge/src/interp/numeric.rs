// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Scalar numeric operations: the context-free Core operators on `i32`,
//! `i64`, `f32`, and `f64`.

use crate::ir::{TrapCode, ValueId};
use crate::opcode::CoreOpcode;

use super::{Fault, Ref, Value};

fn mismatch(expected: &str, actual: &Value) -> Fault {
    Fault::Invalid(format!("expected an {expected} operand, found {actual}"))
}

#[inline(always)]
pub(super) fn i32(value: &Value) -> Result<u32, Fault> {
    match value {
        Value::I32(value) => Ok(*value),
        other => Err(mismatch("i32", other)),
    }
}

#[inline(always)]
pub(super) fn i64(value: &Value) -> Result<u64, Fault> {
    match value {
        Value::I64(value) => Ok(*value),
        other => Err(mismatch("i64", other)),
    }
}

#[inline(always)]
pub(super) fn f32(value: &Value) -> Result<f32, Fault> {
    match value {
        Value::F32(bits) => Ok(f32::from_bits(*bits)),
        other => Err(mismatch("f32", other)),
    }
}

#[inline(always)]
pub(super) fn f64(value: &Value) -> Result<f64, Fault> {
    match value {
        Value::F64(bits) => Ok(f64::from_bits(*bits)),
        other => Err(mismatch("f64", other)),
    }
}

#[inline(always)]
pub(super) fn v128(value: &Value) -> Result<[u8; 16], Fault> {
    match value {
        Value::V128(bytes) => Ok(*bytes),
        other => Err(mismatch("v128", other)),
    }
}

#[inline(always)]
pub(super) fn reference(value: &Value) -> Result<&Ref, Fault> {
    match value {
        Value::Ref(reference) => Ok(reference),
        other => Err(mismatch("reference", other)),
    }
}

/// An `i32` or `i64` address, index, or count, widened.
#[inline(always)]
pub(super) fn address(value: &Value) -> Result<u64, Fault> {
    match value {
        Value::I32(value) => Ok(u64::from(*value)),
        Value::I64(value) => Ok(*value),
        other => Err(mismatch("address", other)),
    }
}

/// The operands of one operation, checked as they are read: either values
/// in hand, or the values of a frame named by the operation's operand
/// ids, so an instruction's operands need not be gathered first.
pub(super) enum Operands<'a> {
    Direct(&'a [Value]),
    Indexed {
        values: &'a [Value],
        ids: &'a [ValueId],
    },
}

impl Operands<'_> {
    #[inline(always)]
    pub fn len(&self) -> usize {
        match self {
            Self::Direct(values) => values.len(),
            Self::Indexed { ids, .. } => ids.len(),
        }
    }

    #[inline(always)]
    pub fn get(&self, index: usize) -> Result<&Value, Fault> {
        match self {
            Self::Direct(values) => values.get(index).ok_or_else(|| {
                Fault::Invalid(format!(
                    "operand {index} is missing; the operation has {}",
                    values.len()
                ))
            }),
            Self::Indexed { values, ids } => {
                let id = ids.get(index).ok_or_else(|| {
                    Fault::Invalid(format!(
                        "operand {index} is missing; the operation has {}",
                        ids.len()
                    ))
                })?;
                values
                    .get(id.index())
                    .ok_or_else(|| Fault::Invalid(format!("{id} is outside the frame")))
            }
        }
    }

    /// Every operand, in order.
    pub fn to_vec(&self) -> Result<Vec<Value>, Fault> {
        (0..self.len())
            .map(|index| self.get(index).copied())
            .collect()
    }

    #[inline(always)]
    pub fn i32(&self, index: usize) -> Result<u32, Fault> {
        i32(self.get(index)?)
    }

    #[inline(always)]
    pub fn i64(&self, index: usize) -> Result<u64, Fault> {
        i64(self.get(index)?)
    }

    #[inline(always)]
    pub fn f32(&self, index: usize) -> Result<f32, Fault> {
        f32(self.get(index)?)
    }

    #[inline(always)]
    pub fn f64(&self, index: usize) -> Result<f64, Fault> {
        f64(self.get(index)?)
    }

    #[inline(always)]
    pub fn v128(&self, index: usize) -> Result<[u8; 16], Fault> {
        v128(self.get(index)?)
    }

    #[inline(always)]
    pub fn reference(&self, index: usize) -> Result<&Ref, Fault> {
        reference(self.get(index)?)
    }

    #[inline(always)]
    pub fn address(&self, index: usize) -> Result<u64, Fault> {
        address(self.get(index)?)
    }
}

fn boolean(value: bool) -> Value {
    Value::I32(u32::from(value))
}

/// WebAssembly `min`: a NaN if either operand is one, and the negative zero
/// when the operands are the two zeros.
pub(super) fn fmin<F: Float>(a: F, b: F) -> F {
    if a.is_nan() || b.is_nan() {
        F::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// WebAssembly `max`, the mirror image of [`fmin`].
pub(super) fn fmax<F: Float>(a: F, b: F) -> F {
    if a.is_nan() || b.is_nan() {
        F::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// What the scalar and lane-wise float operations need of `f32` and `f64`.
pub(super) trait Float: Copy + PartialEq + PartialOrd {
    const NAN: Self;
    fn is_nan(self) -> bool;
    fn is_sign_negative(self) -> bool;
    fn trunc(self) -> Self;
    fn to_f64(self) -> f64;
}

impl Float for f32 {
    const NAN: Self = f32::NAN;
    fn is_nan(self) -> bool {
        f32::is_nan(self)
    }
    fn is_sign_negative(self) -> bool {
        f32::is_sign_negative(self)
    }
    fn trunc(self) -> Self {
        f32::trunc(self)
    }
    fn to_f64(self) -> f64 {
        f64::from(self)
    }
}

impl Float for f64 {
    const NAN: Self = f64::NAN;
    fn is_nan(self) -> bool {
        f64::is_nan(self)
    }
    fn is_sign_negative(self) -> bool {
        f64::is_sign_negative(self)
    }
    fn trunc(self) -> Self {
        f64::trunc(self)
    }
    fn to_f64(self) -> f64 {
        self
    }
}

/// The trapping float-to-integer conversions. The bounds are exact in
/// `f64`, and an `f32` widens exactly, so one check serves both sources.
fn trapping_trunc<F: Float>(value: F, low: f64, high: f64) -> Result<f64, TrapCode> {
    if value.is_nan() {
        return Err(TrapCode::InvalidConversionToInteger);
    }
    let truncated = value.trunc().to_f64();
    if truncated < low || truncated >= high {
        return Err(TrapCode::IntegerOverflow);
    }
    Ok(truncated)
}

pub(super) fn trunc_i32_s<F: Float>(value: F) -> Result<u32, TrapCode> {
    trapping_trunc(value, -2_147_483_648.0, 2_147_483_648.0).map(|t| t as i32 as u32)
}

pub(super) fn trunc_i32_u<F: Float>(value: F) -> Result<u32, TrapCode> {
    // Values in (-1, 0) truncate to negative zero, which is not below zero.
    trapping_trunc(value, 0.0, 4_294_967_296.0).map(|t| t as u32)
}

pub(super) fn trunc_i64_s<F: Float>(value: F) -> Result<u64, TrapCode> {
    trapping_trunc(
        value,
        -9_223_372_036_854_775_808.0,
        9_223_372_036_854_775_808.0,
    )
    .map(|t| t as i64 as u64)
}

pub(super) fn trunc_i64_u<F: Float>(value: F) -> Result<u64, TrapCode> {
    trapping_trunc(value, 0.0, 18_446_744_073_709_551_616.0).map(|t| t as u64)
}

/// The saturating conversions: NaN becomes zero and Rust's `as` clamps.
pub(super) fn trunc_sat_i32_s<F: Float>(value: F) -> u32 {
    if value.is_nan() {
        0
    } else {
        value.to_f64() as i32 as u32
    }
}

pub(super) fn trunc_sat_i32_u<F: Float>(value: F) -> u32 {
    if value.is_nan() {
        0
    } else {
        value.to_f64() as u32
    }
}

pub(super) fn trunc_sat_i64_s<F: Float>(value: F) -> u64 {
    if value.is_nan() {
        0
    } else {
        value.to_f64() as i64 as u64
    }
}

pub(super) fn trunc_sat_i64_u<F: Float>(value: F) -> u64 {
    if value.is_nan() {
        0
    } else {
        value.to_f64() as u64
    }
}

fn div_s32(a: u32, b: u32) -> Result<u32, TrapCode> {
    let (a, b) = (a as i32, b as i32);
    if b == 0 {
        Err(TrapCode::IntegerDivideByZero)
    } else if a == i32::MIN && b == -1 {
        Err(TrapCode::IntegerOverflow)
    } else {
        Ok((a / b) as u32)
    }
}

fn rem_s32(a: u32, b: u32) -> Result<u32, TrapCode> {
    let (a, b) = (a as i32, b as i32);
    if b == 0 {
        Err(TrapCode::IntegerDivideByZero)
    } else {
        Ok(a.wrapping_rem(b) as u32)
    }
}

fn div_u32(a: u32, b: u32) -> Result<u32, TrapCode> {
    a.checked_div(b).ok_or(TrapCode::IntegerDivideByZero)
}

fn rem_u32(a: u32, b: u32) -> Result<u32, TrapCode> {
    a.checked_rem(b).ok_or(TrapCode::IntegerDivideByZero)
}

fn div_s64(a: u64, b: u64) -> Result<u64, TrapCode> {
    let (a, b) = (a as i64, b as i64);
    if b == 0 {
        Err(TrapCode::IntegerDivideByZero)
    } else if a == i64::MIN && b == -1 {
        Err(TrapCode::IntegerOverflow)
    } else {
        Ok((a / b) as u64)
    }
}

fn rem_s64(a: u64, b: u64) -> Result<u64, TrapCode> {
    let (a, b) = (a as i64, b as i64);
    if b == 0 {
        Err(TrapCode::IntegerDivideByZero)
    } else {
        Ok(a.wrapping_rem(b) as u64)
    }
}

fn div_u64(a: u64, b: u64) -> Result<u64, TrapCode> {
    a.checked_div(b).ok_or(TrapCode::IntegerDivideByZero)
}

fn rem_u64(a: u64, b: u64) -> Result<u64, TrapCode> {
    a.checked_rem(b).ok_or(TrapCode::IntegerDivideByZero)
}

/// Executes a scalar numeric `opcode` on `operands`, or returns `None` when
/// the opcode is not one.
pub(super) fn execute(opcode: CoreOpcode, a: &Operands<'_>) -> Result<Option<Value>, Fault> {
    use CoreOpcode::*;

    let i32_binary =
        |f: fn(u32, u32) -> u32| Ok::<Value, Fault>(Value::I32(f(a.i32(0)?, a.i32(1)?)));
    let i32_compare =
        |f: fn(u32, u32) -> bool| Ok::<Value, Fault>(boolean(f(a.i32(0)?, a.i32(1)?)));
    let i32_divide = |f: fn(u32, u32) -> Result<u32, TrapCode>| {
        f(a.i32(0)?, a.i32(1)?).map(Value::I32).map_err(Fault::Trap)
    };
    let i64_binary =
        |f: fn(u64, u64) -> u64| Ok::<Value, Fault>(Value::I64(f(a.i64(0)?, a.i64(1)?)));
    let i64_compare =
        |f: fn(u64, u64) -> bool| Ok::<Value, Fault>(boolean(f(a.i64(0)?, a.i64(1)?)));
    let i64_divide = |f: fn(u64, u64) -> Result<u64, TrapCode>| {
        f(a.i64(0)?, a.i64(1)?).map(Value::I64).map_err(Fault::Trap)
    };
    let f32_unary = |f: fn(f32) -> f32| Ok::<Value, Fault>(Value::f32(f(a.f32(0)?)));
    let f32_binary =
        |f: fn(f32, f32) -> f32| Ok::<Value, Fault>(Value::f32(f(a.f32(0)?, a.f32(1)?)));
    let f32_compare =
        |f: fn(f32, f32) -> bool| Ok::<Value, Fault>(boolean(f(a.f32(0)?, a.f32(1)?)));
    let f64_unary = |f: fn(f64) -> f64| Ok::<Value, Fault>(Value::f64(f(a.f64(0)?)));
    let f64_binary =
        |f: fn(f64, f64) -> f64| Ok::<Value, Fault>(Value::f64(f(a.f64(0)?, a.f64(1)?)));
    let f64_compare =
        |f: fn(f64, f64) -> bool| Ok::<Value, Fault>(boolean(f(a.f64(0)?, a.f64(1)?)));
    let trapping = |result: Result<Value, TrapCode>| result.map_err(Fault::Trap);

    let value = match opcode {
        I32Eqz => boolean(a.i32(0)? == 0),
        I32Eq => i32_compare(|x, y| x == y)?,
        I32Ne => i32_compare(|x, y| x != y)?,
        I32LtS => i32_compare(|x, y| (x as i32) < (y as i32))?,
        I32LtU => i32_compare(|x, y| x < y)?,
        I32GtS => i32_compare(|x, y| (x as i32) > (y as i32))?,
        I32GtU => i32_compare(|x, y| x > y)?,
        I32LeS => i32_compare(|x, y| (x as i32) <= (y as i32))?,
        I32LeU => i32_compare(|x, y| x <= y)?,
        I32GeS => i32_compare(|x, y| (x as i32) >= (y as i32))?,
        I32GeU => i32_compare(|x, y| x >= y)?,
        I64Eqz => boolean(a.i64(0)? == 0),
        I64Eq => i64_compare(|x, y| x == y)?,
        I64Ne => i64_compare(|x, y| x != y)?,
        I64LtS => i64_compare(|x, y| (x as i64) < (y as i64))?,
        I64LtU => i64_compare(|x, y| x < y)?,
        I64GtS => i64_compare(|x, y| (x as i64) > (y as i64))?,
        I64GtU => i64_compare(|x, y| x > y)?,
        I64LeS => i64_compare(|x, y| (x as i64) <= (y as i64))?,
        I64LeU => i64_compare(|x, y| x <= y)?,
        I64GeS => i64_compare(|x, y| (x as i64) >= (y as i64))?,
        I64GeU => i64_compare(|x, y| x >= y)?,
        F32Eq => f32_compare(|x, y| x == y)?,
        F32Ne => f32_compare(|x, y| x != y)?,
        F32Lt => f32_compare(|x, y| x < y)?,
        F32Gt => f32_compare(|x, y| x > y)?,
        F32Le => f32_compare(|x, y| x <= y)?,
        F32Ge => f32_compare(|x, y| x >= y)?,
        F64Eq => f64_compare(|x, y| x == y)?,
        F64Ne => f64_compare(|x, y| x != y)?,
        F64Lt => f64_compare(|x, y| x < y)?,
        F64Gt => f64_compare(|x, y| x > y)?,
        F64Le => f64_compare(|x, y| x <= y)?,
        F64Ge => f64_compare(|x, y| x >= y)?,

        I32Clz => Value::I32(a.i32(0)?.leading_zeros()),
        I32Ctz => Value::I32(a.i32(0)?.trailing_zeros()),
        I32Popcnt => Value::I32(a.i32(0)?.count_ones()),
        I32Add => i32_binary(u32::wrapping_add)?,
        I32Sub => i32_binary(u32::wrapping_sub)?,
        I32Mul => i32_binary(u32::wrapping_mul)?,
        I32DivS => i32_divide(div_s32)?,
        I32DivU => i32_divide(div_u32)?,
        I32RemS => i32_divide(rem_s32)?,
        I32RemU => i32_divide(rem_u32)?,
        I32And => i32_binary(|x, y| x & y)?,
        I32Or => i32_binary(|x, y| x | y)?,
        I32Xor => i32_binary(|x, y| x ^ y)?,
        I32Shl => i32_binary(|x, y| x.wrapping_shl(y))?,
        I32ShrS => i32_binary(|x, y| (x as i32).wrapping_shr(y) as u32)?,
        I32ShrU => i32_binary(|x, y| x.wrapping_shr(y))?,
        I32Rotl => i32_binary(|x, y| x.rotate_left(y & 31))?,
        I32Rotr => i32_binary(|x, y| x.rotate_right(y & 31))?,
        I64Clz => Value::I64(u64::from(a.i64(0)?.leading_zeros())),
        I64Ctz => Value::I64(u64::from(a.i64(0)?.trailing_zeros())),
        I64Popcnt => Value::I64(u64::from(a.i64(0)?.count_ones())),
        I64Add => i64_binary(u64::wrapping_add)?,
        I64Sub => i64_binary(u64::wrapping_sub)?,
        I64Mul => i64_binary(u64::wrapping_mul)?,
        I64DivS => i64_divide(div_s64)?,
        I64DivU => i64_divide(div_u64)?,
        I64RemS => i64_divide(rem_s64)?,
        I64RemU => i64_divide(rem_u64)?,
        I64And => i64_binary(|x, y| x & y)?,
        I64Or => i64_binary(|x, y| x | y)?,
        I64Xor => i64_binary(|x, y| x ^ y)?,
        I64Shl => i64_binary(|x, y| x.wrapping_shl(y as u32))?,
        I64ShrS => i64_binary(|x, y| (x as i64).wrapping_shr(y as u32) as u64)?,
        I64ShrU => i64_binary(|x, y| x.wrapping_shr(y as u32))?,
        I64Rotl => i64_binary(|x, y| x.rotate_left((y & 63) as u32))?,
        I64Rotr => i64_binary(|x, y| x.rotate_right((y & 63) as u32))?,

        F32Abs => f32_unary(f32::abs)?,
        F32Neg => f32_unary(|x| -x)?,
        F32Ceil => f32_unary(f32::ceil)?,
        F32Floor => f32_unary(f32::floor)?,
        F32Trunc => f32_unary(f32::trunc)?,
        F32Nearest => f32_unary(f32::round_ties_even)?,
        F32Sqrt => f32_unary(f32::sqrt)?,
        F32Add => f32_binary(|x, y| x + y)?,
        F32Sub => f32_binary(|x, y| x - y)?,
        F32Mul => f32_binary(|x, y| x * y)?,
        F32Div => f32_binary(|x, y| x / y)?,
        F32Min => f32_binary(fmin)?,
        F32Max => f32_binary(fmax)?,
        F32Copysign => f32_binary(f32::copysign)?,
        F64Abs => f64_unary(f64::abs)?,
        F64Neg => f64_unary(|x| -x)?,
        F64Ceil => f64_unary(f64::ceil)?,
        F64Floor => f64_unary(f64::floor)?,
        F64Trunc => f64_unary(f64::trunc)?,
        F64Nearest => f64_unary(f64::round_ties_even)?,
        F64Sqrt => f64_unary(f64::sqrt)?,
        F64Add => f64_binary(|x, y| x + y)?,
        F64Sub => f64_binary(|x, y| x - y)?,
        F64Mul => f64_binary(|x, y| x * y)?,
        F64Div => f64_binary(|x, y| x / y)?,
        F64Min => f64_binary(fmin)?,
        F64Max => f64_binary(fmax)?,
        F64Copysign => f64_binary(f64::copysign)?,

        I32WrapI64 => Value::I32(a.i64(0)? as u32),
        I32TruncF32S => trapping(trunc_i32_s(a.f32(0)?).map(Value::I32))?,
        I32TruncF32U => trapping(trunc_i32_u(a.f32(0)?).map(Value::I32))?,
        I32TruncF64S => trapping(trunc_i32_s(a.f64(0)?).map(Value::I32))?,
        I32TruncF64U => trapping(trunc_i32_u(a.f64(0)?).map(Value::I32))?,
        I64ExtendI32S => Value::I64(a.i32(0)? as i32 as i64 as u64),
        I64ExtendI32U => Value::I64(u64::from(a.i32(0)?)),
        I64TruncF32S => trapping(trunc_i64_s(a.f32(0)?).map(Value::I64))?,
        I64TruncF32U => trapping(trunc_i64_u(a.f32(0)?).map(Value::I64))?,
        I64TruncF64S => trapping(trunc_i64_s(a.f64(0)?).map(Value::I64))?,
        I64TruncF64U => trapping(trunc_i64_u(a.f64(0)?).map(Value::I64))?,
        F32ConvertI32S => Value::f32(a.i32(0)? as i32 as f32),
        F32ConvertI32U => Value::f32(a.i32(0)? as f32),
        F32ConvertI64S => Value::f32(a.i64(0)? as i64 as f32),
        F32ConvertI64U => Value::f32(a.i64(0)? as f32),
        F32DemoteF64 => Value::f32(a.f64(0)? as f32),
        F64ConvertI32S => Value::f64(f64::from(a.i32(0)? as i32)),
        F64ConvertI32U => Value::f64(f64::from(a.i32(0)?)),
        F64ConvertI64S => Value::f64(a.i64(0)? as i64 as f64),
        F64ConvertI64U => Value::f64(a.i64(0)? as f64),
        F64PromoteF32 => Value::f64(f64::from(a.f32(0)?)),
        I32ReinterpretF32 => Value::I32(a.f32(0)?.to_bits()),
        I64ReinterpretF64 => Value::I64(a.f64(0)?.to_bits()),
        F32ReinterpretI32 => Value::F32(a.i32(0)?),
        F64ReinterpretI64 => Value::F64(a.i64(0)?),

        I32Extend8S => Value::I32(a.i32(0)? as i8 as i32 as u32),
        I32Extend16S => Value::I32(a.i32(0)? as i16 as i32 as u32),
        I64Extend8S => Value::I64(a.i64(0)? as i8 as i64 as u64),
        I64Extend16S => Value::I64(a.i64(0)? as i16 as i64 as u64),
        I64Extend32S => Value::I64(a.i64(0)? as i32 as i64 as u64),

        I32TruncSatF32S => Value::I32(trunc_sat_i32_s(a.f32(0)?)),
        I32TruncSatF32U => Value::I32(trunc_sat_i32_u(a.f32(0)?)),
        I32TruncSatF64S => Value::I32(trunc_sat_i32_s(a.f64(0)?)),
        I32TruncSatF64U => Value::I32(trunc_sat_i32_u(a.f64(0)?)),
        I64TruncSatF32S => Value::I64(trunc_sat_i64_s(a.f32(0)?)),
        I64TruncSatF32U => Value::I64(trunc_sat_i64_u(a.f32(0)?)),
        I64TruncSatF64S => Value::I64(trunc_sat_i64_s(a.f64(0)?)),
        I64TruncSatF64U => Value::I64(trunc_sat_i64_u(a.f64(0)?)),

        _ => return Ok(None),
    };
    Ok(Some(value))
}
