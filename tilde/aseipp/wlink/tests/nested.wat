;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The shape a composition tool produces: both parties nested inside one
;; outer component and wired together by instantiation arguments.
(component
  (component $producer
    (core module $m
      (func (export "double") (param i32) (result i32)
        local.get 0
        i32.const 2
        i32.mul))
    (core instance $i (instantiate $m))
    (func $double (param "n" u32) (result u32) (canon lift (core func $i "double")))
    (instance $exports (export "double" (func $double)))
    (export "test:nested/ops" (instance $exports)))
  (component $consumer
    (import "test:nested/ops" (instance $ops
      (export "double" (func (param "n" u32) (result u32)))))
    (core func $double (canon lower (func $ops "double")))
    (core module $m
      (import "test:nested/ops" "double" (func $double (param i32) (result i32)))
      (func (export "run") (result i32)
        i32.const 21
        call $double))
    (core instance $i (instantiate $m
      (with "test:nested/ops" (instance (export "double" (func $double))))))
    (func $run (result u32) (canon lift (core func $i "run")))
    (export "run" (func $run)))
  (instance $p (instantiate $producer))
  (instance $c (instantiate $consumer (with "test:nested/ops" (instance $p "test:nested/ops"))))
  (export "run" (func $c "run"))
)
