;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $pair (func (param i32) (result i32 i64)))
  (func (export "pair") (type $pair) (param $value i32) (result i32 i64)
    block (result i32 i64)
      local.get $value
      local.get $value
      i64.extend_i32_u
    end))
