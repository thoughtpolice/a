;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A function with more flat parameters than the ABI passes directly, so the
;; arguments arrive through memory.
(component
  (core module $m
    (memory (export "memory") 1)
    (global $bump (mut i32) (i32.const 4096))
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (local $ptr i32)
      global.get $bump
      local.set $ptr
      global.get $bump
      local.get 3
      i32.add
      global.set $bump
      local.get $ptr)
    ;; Sums the sixteen u32 fields and the length of the trailing string.
    (func (export "sum") (param $args i32) (result i32)
      (local $i i32)
      (local $acc i32)
      loop $l
        local.get $args
        local.get $i
        i32.const 4
        i32.mul
        i32.add
        i32.load
        local.get $acc
        i32.add
        local.set $acc
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        i32.const 16
        i32.lt_u
        br_if $l
      end
      local.get $acc
      local.get $args
      i32.load offset=68
      i32.add))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "cabi_realloc" (core func $realloc))
  (func $sum
    (param "a" u32) (param "b" u32) (param "c" u32) (param "d" u32)
    (param "e" u32) (param "f" u32) (param "g" u32) (param "h" u32)
    (param "i" u32) (param "j" u32) (param "k" u32) (param "l" u32)
    (param "m" u32) (param "n" u32) (param "o" u32) (param "p" u32)
    (param "tail" string)
    (result u32)
    (canon lift (core func $i "sum") (memory $memory) (realloc $realloc) string-encoding=utf8))
  (instance $exports (export "sum" (func $sum)))
  (export "test:wide/api" (instance $exports))
)
