;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Imports nothing another component provides: both imports must survive as
;; imports of the linked module, in lowered form.
(component
  (import "tick" (func $tick (param "n" u32) (result u32)))
  (import "test:hal/raw" (instance $raw
    (export "log" (func (param "message" string)))))
  (core module $mem
    (memory (export "memory") 1))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (core func $tick_core (canon lower (func $tick)))
  (core func $log (canon lower (func $raw "log") (memory $memory) string-encoding=utf8))
  (core module $m
    (import "$root" "tick" (func $tick (param i32) (result i32)))
    (import "test:hal/raw" "log" (func $log (param i32 i32)))
    (func (export "run") (result i32)
      i32.const 0
      i32.const 0
      call $log
      i32.const 1
      call $tick))
  (core instance $i (instantiate $m
    (with "$root" (instance (export "tick" (func $tick_core))))
    (with "test:hal/raw" (instance (export "log" (func $log))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
