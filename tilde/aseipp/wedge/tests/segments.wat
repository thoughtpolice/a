;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func $target)
  (table 2 funcref)
  (memory 1)

  ;; Active, passive, and declarative element segments.
  (elem (i32.const 0) func $target)
  (elem func $target)
  (elem declare func $target)

  ;; Active and passive data segments.
  (data (i32.const 0) "active")
  (data "passive"))
