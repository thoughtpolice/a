;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  ;; Every defaultable Core value category receives an explicit SSA
  ;; definition at function entry. Nullable reference locals initialize to a
  ;; null of their declared heap type.
  (func (export "defaults")
    (result i32 i64 f32 f64 v128 funcref externref)
    (local i32 i64 f32 f64 v128 funcref externref)
    local.get 0
    local.get 1
    local.get 2
    local.get 3
    local.get 4
    local.get 5
    local.get 6))
