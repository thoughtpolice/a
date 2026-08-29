;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (table $source 2 externref)
  (table $destination 3 externref)

  (func (export "size") (result i32)
    table.size $source)

  (func (export "grow") (param $value externref) (param $count i32) (result i32)
    local.get $value
    local.get $count
    table.grow $source)

  (func (export "fill") (param $start i32) (param $value externref) (param $count i32)
    local.get $start
    local.get $value
    local.get $count
    table.fill $destination)

  (func (export "copy") (param $destination_offset i32) (param $source_offset i32) (param $count i32)
    local.get $destination_offset
    local.get $source_offset
    local.get $count
    table.copy $destination $source))
