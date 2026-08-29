;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $nullary (func))
  (func $target)
  (memory 1)
  (table 1 funcref)
  (data $bytes "wedge")
  (elem $functions func $target)

  (func (export "initialize")
    i32.const 0
    i32.const 0
    i32.const 5
    memory.init $bytes
    data.drop $bytes

    i32.const 0
    i32.const 0
    i32.const 1
    table.init $functions
    elem.drop $functions

    i32.const 8
    i32.const 0
    i32.const 5
    memory.copy

    i32.const 16
    i32.const 0
    i32.const 4
    memory.fill))
