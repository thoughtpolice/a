;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The first instance's start must run before the second writes shared memory.
(component
  (core module $first
    (memory (export "memory") 1)
    (data (i32.const 0) "\01")
    (global $saved (mut i32) (i32.const 0))
    (func $start
      i32.const 0
      i32.load8_u
      global.set $saved)
    (start $start)
    (func (export "run") (result i32) global.get $saved))
  (core instance $a (instantiate $first))
  (core module $second
    (import "a" "memory" (memory 1))
    (data (i32.const 0) "\02"))
  (core instance $b (instantiate $second (with "a" (instance $a))))
  (func $run (result u32) (canon lift (core func $a "run")))
  (export "run" (func $run)))
