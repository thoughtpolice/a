;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory 1 1 shared)
  (func (export "atomic_add") (param $address i32) (param $value i32) (result i32)
    local.get $address
    local.get $value
    i32.atomic.rmw.add))
