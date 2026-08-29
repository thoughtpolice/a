;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $unary (func (param i32) (result i32)))
  (func $increment (type $unary) (param $value i32) (result i32)
    local.get $value
    i32.const 1
    i32.add)
  (table (export "functions") 1 funcref)
  (elem (i32.const 0) $increment)

  (func (export "indirect") (param $value i32) (result i32)
    local.get $value
    i32.const 0
    call_indirect (type $unary)))
