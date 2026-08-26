;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory (export "memory") 1)
  (data (i32.const 0) "wabt")
  (global $bias i32 (i32.const 1))
  (func (export "add") (param $lhs i32) (param $rhs i32) (result i32)
    local.get $lhs
    local.get $rhs
    i32.add
    global.get $bias
    i32.add)
  (func (export "answer") (result i32)
    i32.const 42))
