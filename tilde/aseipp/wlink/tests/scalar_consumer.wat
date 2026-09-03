;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Imports test:math/ops and exports run, which computes 40 + 2 through it.
(component
  (import "test:math/ops" (instance $ops
    (export "add" (func (param "a" u32) (param "b" u32) (result u32)))))
  (core func $add (canon lower (func $ops "add")))
  (core module $m
    (import "test:math/ops" "add" (func $add (param i32 i32) (result i32)))
    (func (export "run") (result i32)
      i32.const 40
      i32.const 2
      call $add))
  (core instance $i (instantiate $m
    (with "test:math/ops" (instance (export "add" (func $add))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
