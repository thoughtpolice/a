;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "integer_unary") (param $value i32) (result i32)
    local.get $value
    i32.clz)

  (func (export "integer_binary") (param $lhs i32) (param $rhs i32) (result i32)
    local.get $lhs
    local.get $rhs
    i32.rotr)

  (func (export "integer_compare") (param $lhs i64) (param $rhs i64) (result i32)
    local.get $lhs
    local.get $rhs
    i64.ge_s)

  (func (export "float_unary") (param $value f32) (result f32)
    local.get $value
    f32.nearest)

  (func (export "float_binary") (param $lhs f64) (param $rhs f64) (result f64)
    local.get $lhs
    local.get $rhs
    f64.copysign)

  (func (export "float_compare") (param $lhs f32) (param $rhs f32) (result i32)
    local.get $lhs
    local.get $rhs
    f32.le)

  (func (export "widen_and_convert") (param $value i32) (result f64)
    local.get $value
    i64.extend_i32_u
    f64.convert_i64_u)

  (func (export "wrap") (param $value i64) (result i32)
    local.get $value
    i32.wrap_i64)

  (func (export "truncate") (param $value f64) (result i32)
    local.get $value
    i32.trunc_f64_s)

  (func (export "promote") (param $value f32) (result f64)
    local.get $value
    f64.promote_f32)

  (func (export "demote") (param $value f64) (result f32)
    local.get $value
    f32.demote_f64)

  (func (export "reinterpret_64") (param $value i64) (result f64)
    local.get $value
    f64.reinterpret_i64)

  (func (export "reinterpret_32") (param $value f32) (result i32)
    local.get $value
    i32.reinterpret_f32))
