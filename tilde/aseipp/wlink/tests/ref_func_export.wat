;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The core export is the only declaration of the reference used in run.
(component
  (core module $m
    (type $answer (func (result i32)))
    (table 1 funcref)
    (func $answer (result i32) i32.const 42)
    (elem $pending func $answer)
    (func $helper (export "helper"))
    (func (export "run") (result i32)
      ref.func $helper
      drop
      ;; Adding declarations must not change this segment's index.
      i32.const 0 i32.const 0 i32.const 1 table.init $pending
      elem.drop $pending
      i32.const 0 call_indirect (type $answer)))
  (core instance $i (instantiate $m))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run)))
