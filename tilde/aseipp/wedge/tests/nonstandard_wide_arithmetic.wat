;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (param $lhs i64) (param $rhs i64) (result i64 i64)
    local.get $lhs
    local.get $rhs
    i64.mul_wide_u))
