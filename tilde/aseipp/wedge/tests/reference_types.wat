;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (table $externs 2 externref)

  (func (export "round_trip") (param $value externref) (result externref)
    i32.const 0
    local.get $value
    table.set $externs
    i32.const 0
    table.get $externs)

  (func (export "is_null") (result i32)
    ref.null extern
    ref.is_null))
