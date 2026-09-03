;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A start can grow a memory before a later instance initializes its new pages.
(component
  (core module $first
    (memory (export "memory") 1)
    (func $start i32.const 1 memory.grow drop)
    (start $start))
  (core instance $a (instantiate $first))
  (core module $second
    (import "a" "memory" (memory 1))
    (data (i32.const 65536) "\2a")
    (func (export "run") (result i32) i32.const 65536 i32.load8_u))
  (core instance $b (instantiate $second (with "a" (instance $a))))
  (func $run (result u32) (canon lift (core func $b "run")))
  (export "run" (func $run)))
