;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "extend") (param $value i32) (result i64)
    local.get $value
    i32.extend8_s
    i64.extend_i32_s
    i64.extend32_s))
