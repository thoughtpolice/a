;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  ;; Memory64 standardizes 64-bit table indices as well as 64-bit memories.
  (table $objects i64 2 externref)

  (func (export "size") (result i64)
    table.size $objects)

  (func (export "round_trip")
      (param $index i64)
      (param $value externref)
      (result externref)
    local.get $index
    local.get $value
    table.set $objects
    local.get $index
    table.get $objects))
