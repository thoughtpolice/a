;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $unary (func (param i32) (result i32)))
  (func $callee (type $unary) (param $value i32) (result i32)
    local.get $value)
  (table $callees 1 funcref)
  (elem (i32.const 0) func $callee)

  (func (export "tail") (type $unary) (param $value i32) (result i32)
    local.get $value
    return_call $callee)

  (func (export "tail_indirect") (type $unary) (param $value i32) (result i32)
    local.get $value
    i32.const 0
    return_call_indirect $callees (type $unary)))
