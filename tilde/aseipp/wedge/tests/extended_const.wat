;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (import "host" "base" (global $base i32))
  (memory 1)
  (global (export "answer") i32
    (i32.add (global.get $base) (i32.const 2)))
  (data (i32.add (global.get $base) (i32.const 8)) "wedge"))
