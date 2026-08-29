;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "choose") (param $condition i32) (result i32)
    block $chosen (result i32)
      i32.const 7
      local.get $condition
      br_if $chosen
      drop
      i32.const 9
    end)

  (func (export "dispatch") (param $selector i32) (result i32)
    block $exit (result i32)
      i32.const 11
      local.get $selector
      br_table $exit $exit
    end))
