;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Exports test:geo/shapes. area takes a record, four flat values that bind
;; directly; corner returns one, two flat values that spill through memory.
(component
  (core module $m
    (memory (export "memory") 1)
    (func (export "area") (param i32 i32 i32 i32) (result i32)
      local.get 2
      local.get 3
      i32.mul)
    (func (export "corner") (param i32 i32 i32 i32) (result i32)
      ;; The far corner, written to a fixed return area.
      i32.const 64
      local.get 0
      local.get 2
      i32.add
      i32.store
      i32.const 68
      local.get 1
      local.get 3
      i32.add
      i32.store
      i32.const 64))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (type $rect (record (field "x" s32) (field "y" s32) (field "w" u32) (field "h" u32)))
  (type $point (record (field "x" s32) (field "y" s32)))
  (func $area (param "r" $rect) (result u32) (canon lift (core func $i "area")))
  (func $corner (param "r" $rect) (result $point)
    (canon lift (core func $i "corner") (memory $memory)))
  (instance $exports
    (export "rect" (type $rect))
    (export "point" (type $point))
    (export "area" (func $area))
    (export "corner" (func $corner)))
  (export "test:geo/shapes" (instance $exports))
)
