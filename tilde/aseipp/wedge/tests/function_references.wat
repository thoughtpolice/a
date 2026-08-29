;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $unary (func (param i32) (result i32)))
  (func $increment (type $unary) (param $value i32) (result i32)
    local.get $value
    i32.const 1
    i32.add)
  (elem declare func $increment)

  (func (export "call_typed") (param $value i32) (result i32)
    local.get $value
    ref.func $increment
    call_ref $unary)

  (func (export "tail_typed") (type $unary) (param $value i32) (result i32)
    local.get $value
    ref.func $increment
    return_call_ref $unary))
