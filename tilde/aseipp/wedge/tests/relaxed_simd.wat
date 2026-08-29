;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "multiply_add")
      (param $lhs v128)
      (param $rhs v128)
      (param $addend v128)
      (result v128)
    local.get $lhs
    local.get $rhs
    local.get $addend
    f32x4.relaxed_madd))
