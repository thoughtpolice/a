;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Both lowers use this memory; host_b lowers the same import in another memory.
(component
  (import "host" (instance $host
    (export "read" (func (param "message" string) (result u32)))))
  (core module $mem
    (memory (export "memory") 1)
    (data (i32.const 0) "a"))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (core func $read (canon lower (func $host "read") (memory $memory)))
  (core func $again (canon lower (func $host "read") (memory $memory)))
  (core module $m
    (import "host" "read" (func $read (param i32 i32) (result i32)))
    (import "host" "again" (func $again (param i32 i32) (result i32)))
    (func (export "run") (result i32)
      i32.const 0 i32.const 1 call $read
      i32.const 0 i32.const 1 call $again
      i32.add))
  (core instance $i (instantiate $m
    (with "host" (instance
      (export "read" (func $read))
      (export "again" (func $again))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run-a" (func $run)))
