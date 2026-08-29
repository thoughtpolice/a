;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory $input 1)
  (memory $output 1)
  (data (memory $input) (i32.const 0) "wedge")

  (func (export "copy")
    i32.const 0
    i32.const 0
    i32.const 5
    memory.copy $output $input)

  (func (export "load") (param $address i32) (result i32)
    local.get $address
    i32.load $output))
