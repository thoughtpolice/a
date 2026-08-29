;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory $memory 1)

  (func (export "extract_lane") (param $value v128) (result i32)
    local.get $value
    i8x16.extract_lane_s 7)

  (func (export "replace_lane") (param $vector v128) (param $value i32) (result v128)
    local.get $vector
    local.get $value
    i8x16.replace_lane 5)

  (func (export "load_lane") (param $address i32) (param $vector v128) (result v128)
    local.get $address
    local.get $vector
    v128.load8_lane $memory offset=9 align=1 3)

  (func (export "store_lane") (param $address i32) (param $vector v128)
    local.get $address
    local.get $vector
    v128.store16_lane $memory offset=6 align=2 4)

  (func (export "select_bits")
      (param $lhs v128)
      (param $rhs v128)
      (param $mask v128)
      (result v128)
    local.get $lhs
    local.get $rhs
    local.get $mask
    v128.bitselect)

  (func (export "splat") (param $value f64) (result v128)
    local.get $value
    f64x2.splat)

  (func (export "convert") (param $value v128) (result v128)
    local.get $value
    i32x4.trunc_sat_f32x4_s))
