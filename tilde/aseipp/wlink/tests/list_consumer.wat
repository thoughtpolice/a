;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Imports test:seq/ops. run sums four numbers kept in this memory; run_iota
;; receives a list the adapter copies into it; run_total passes two rows of
;; numbers; run_label receives a string inside an option.
(component
  (import "test:seq/ops" (instance $api
    (export "sum" (func (param "values" (list u32)) (result u32)))
    (export "iota" (func (param "n" u32) (result (list u8))))
    (type $rows (list (list u32)))
    (export "total" (func (param "rows" $rows) (result u32)))
    (type $label (option string))
    (export "label" (func (param "n" u32) (result $label)))))
  (core module $mem
    (memory (export "memory") 1)
    (data (i32.const 16) "\01\00\00\00\02\00\00\00\03\00\00\00\04\00\00\00")
    ;; Two rows, [1, 2, 3] and [4, 5], described by pairs at 160.
    (data (i32.const 128) "\01\00\00\00\02\00\00\00\03\00\00\00")
    (data (i32.const 144) "\04\00\00\00\05\00\00\00")
    (data (i32.const 160) "\80\00\00\00\03\00\00\00\90\00\00\00\02\00\00\00")
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      i32.const 2048))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (alias core export $mi "cabi_realloc" (core func $realloc))
  (core func $sum (canon lower (func $api "sum") (memory $memory)))
  (core func $iota (canon lower (func $api "iota") (memory $memory) (realloc $realloc)))
  (core func $total (canon lower (func $api "total") (memory $memory)))
  (core func $label (canon lower (func $api "label") (memory $memory) (realloc $realloc)))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:seq/ops" "sum" (func $sum (param i32 i32) (result i32)))
    (import "test:seq/ops" "iota" (func $iota (param i32 i32)))
    (import "test:seq/ops" "total" (func $total (param i32 i32) (result i32)))
    (import "test:seq/ops" "label" (func $label (param i32 i32)))
    (func (export "run") (result i32)
      i32.const 16
      i32.const 4
      call $sum)
    (func (export "run_iota") (result i32)
      i32.const 4
      i32.const 64
      call $iota
      ;; The length, a hundredfold, plus the last byte of the copied list.
      i32.const 68
      i32.load
      i32.const 100
      i32.mul
      i32.const 64
      i32.load
      i32.const 3
      i32.add
      i32.load8_u
      i32.add)
    (func (export "run_total") (result i32)
      i32.const 160
      i32.const 2
      call $total)
    (func (export "run_label") (result i32)
      ;; some("abc"): the discriminant a hundredfold, the length tenfold,
      ;; and the last byte of the copied string; then none adds nothing.
      i32.const 1
      i32.const 256
      call $label
      i32.const 256
      i32.load8_u
      i32.const 100
      i32.mul
      i32.const 264
      i32.load
      i32.const 10
      i32.mul
      i32.add
      i32.const 260
      i32.load
      i32.const 2
      i32.add
      i32.load8_u
      i32.add
      i32.const 0
      i32.const 256
      call $label
      i32.const 256
      i32.load8_u
      i32.add))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:seq/ops" (instance
      (export "sum" (func $sum))
      (export "iota" (func $iota))
      (export "total" (func $total))
      (export "label" (func $label))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (func $run_iota (result u32) (canon lift (core func $i "run_iota")))
  (func $run_total (result u32) (canon lift (core func $i "run_total")))
  (func $run_label (result u32) (canon lift (core func $i "run_label")))
  (export "run" (func $run))
  (export "run-iota" (func $run_iota))
  (export "run-total" (func $run_total))
  (export "run-label" (func $run_label))
)
