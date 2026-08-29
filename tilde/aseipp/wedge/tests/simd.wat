;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "add_lanes") (param $lhs v128) (param $rhs v128) (result v128)
    local.get $lhs
    local.get $rhs
    i32x4.add)

  (func (export "shuffle") (param $value v128) (result v128)
    local.get $value
    v128.const i32x4 0 0 0 0
    i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23))
