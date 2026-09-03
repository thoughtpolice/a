;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Calls test:wide/api with arguments spilled to its own memory.
(component
  (import "test:wide/api" (instance $api
    (export "sum" (func
      (param "a" u32) (param "b" u32) (param "c" u32) (param "d" u32)
      (param "e" u32) (param "f" u32) (param "g" u32) (param "h" u32)
      (param "i" u32) (param "j" u32) (param "k" u32) (param "l" u32)
      (param "m" u32) (param "n" u32) (param "o" u32) (param "p" u32)
      (param "tail" string)
      (result u32)))))
  (core module $mem
    (memory (export "memory") 1)
    (data (i32.const 256) "abc"))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (core func $sum (canon lower (func $api "sum") (memory $memory) string-encoding=utf8))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:wide/api" "sum" (func $sum (param i32) (result i32)))
    (func (export "run") (result i32)
      (local $i i32)
      ;; Fields 0..16 hold 1..16, then the string (ptr 256, len 3).
      loop $l
        local.get $i
        i32.const 4
        i32.mul
        local.get $i
        i32.const 1
        i32.add
        i32.store
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        i32.const 16
        i32.lt_u
        br_if $l
      end
      i32.const 64
      i32.const 256
      i32.store
      i32.const 68
      i32.const 3
      i32.store
      i32.const 0
      call $sum))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:wide/api" (instance (export "sum" (func $sum))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
