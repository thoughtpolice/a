;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "truncate") (param $value f32) (result i32)
    local.get $value
    i32.trunc_sat_f32_s)

  (func (export "truncate_wide") (param $value f64) (result i64)
    local.get $value
    i64.trunc_sat_f64_u))
