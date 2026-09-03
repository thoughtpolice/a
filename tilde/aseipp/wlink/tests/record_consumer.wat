;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Imports test:geo/shapes. corner's result lands in this memory, at the
;; return pointer run supplies.
(component
  (import "test:geo/shapes" (instance $api
    (type $rect_def (record (field "x" s32) (field "y" s32) (field "w" u32) (field "h" u32)))
    (export "rect" (type $rect (eq $rect_def)))
    (type $point_def (record (field "x" s32) (field "y" s32)))
    (export "point" (type $point (eq $point_def)))
    (export "area" (func (param "r" $rect) (result u32)))
    (export "corner" (func (param "r" $rect) (result $point)))))
  (core module $mem
    (memory (export "memory") 1))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (core func $area (canon lower (func $api "area")))
  (core func $corner (canon lower (func $api "corner") (memory $memory)))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:geo/shapes" "area" (func $area (param i32 i32 i32 i32) (result i32)))
    (import "test:geo/shapes" "corner" (func $corner (param i32 i32 i32 i32 i32)))
    (func (export "run") (result i32)
      ;; area(3, 4, 5, 6) + corner(3, 4, 5, 6).x + corner(3, 4, 5, 6).y
      i32.const 3
      i32.const 4
      i32.const 5
      i32.const 6
      call $area
      i32.const 3
      i32.const 4
      i32.const 5
      i32.const 6
      i32.const 128
      call $corner
      i32.const 128
      i32.load
      i32.add
      i32.const 132
      i32.load
      i32.add))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:geo/shapes" (instance
      (export "area" (func $area))
      (export "corner" (func $corner))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
