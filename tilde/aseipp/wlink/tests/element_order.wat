;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A later element segment must not replace a function before an earlier start.
(component
  (core module $first
    (type $answer (func (result i32)))
    (table (export "table") 1 funcref)
    (func $one (result i32) i32.const 1)
    (elem (i32.const 0) $one)
    (global $saved (mut i32) (i32.const 0))
    (func $start
      i32.const 0
      call_indirect (type $answer)
      global.set $saved)
    (start $start)
    (func (export "run") (result i32) global.get $saved))
  (core instance $a (instantiate $first))
  (core module $second
    (import "a" "table" (table 1 funcref))
    (func $two (result i32) i32.const 2)
    (elem (i32.const 0) $two))
  (core instance $b (instantiate $second (with "a" (instance $a))))
  (func $run (result u32) (canon lift (core func $a "run")))
  (export "run" (func $run)))
