;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory $memory i64 1 4)

  (func (export "size") (result i64)
    memory.size $memory)

  (func (export "grow") (param $pages i64) (result i64)
    local.get $pages
    memory.grow $memory)

  (func (export "load") (param $address i64) (result i32)
    local.get $address
    i32.load $memory))
