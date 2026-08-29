;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory (export "memory") 1 4)

  (func (export "round_trip") (param $address i32) (param $value i32) (result i32)
    local.get $address
    local.get $value
    i32.store offset=4 align=4
    local.get $address
    i32.load offset=4 align=4)

  (func (export "grow") (param $pages i32) (result i32)
    local.get $pages
    memory.grow))
