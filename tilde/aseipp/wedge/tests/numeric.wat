;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "integer") (param $lhs i64) (param $rhs i64) (result i64)
    local.get $lhs
    local.get $rhs
    i64.mul
    i64.const 3
    i64.add)

  (func (export "floating") (param $value f64) (result f64)
    local.get $value
    f64.sqrt
    f64.const 0x1.8p+1
    f64.add)

  (func (export "reinterpret") (param $bits i32) (result f32)
    local.get $bits
    f32.reinterpret_i32))
