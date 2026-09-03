;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Exports a scalar-only interface: every call into it binds directly.
(component
  (core module $m
    (func (export "add") (param i32 i32) (result i32)
      local.get 0
      local.get 1
      i32.add))
  (core instance $i (instantiate $m))
  (func $add (param "a" u32) (param "b" u32) (result u32)
    (canon lift (core func $i "add")))
  (instance $exports (export "add" (func $add)))
  (export "test:math/ops" (instance $exports))
)
