;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A consumer that keeps its state on the GC heap, as gameplayc modules do:
;; a recursive type group of five heap types precedes the function types. It
;; imports test:math/ops, which the scalar producer provides, and tick, which
;; nothing provides, so the linked module gets a function type added after
;; the group for the import that remains. A group is one type-section entry
;; holding five types; the added type must be numbered past all of them.
(component
  (import "tick" (func $tick (param "n" u32) (result u32)))
  (import "test:math/ops" (instance $ops
    (export "add" (func (param "a" u32) (param "b" u32) (result u32)))))
  (core func $tick_core (canon lower (func $tick)))
  (core func $add (canon lower (func $ops "add")))
  (core module $m
    (rec
      (type $node (struct (field $value (mut i32)) (field $next (mut (ref null $node)))))
      (type $values (array (mut i32)))
      (type $pair (struct (field f32) (field f64)))
      (type $wide (struct (field i64)))
      (type $nodes (array (mut (ref null $node)))))
    (import "$root" "tick" (func $tick (param i32) (result i32)))
    (import "test:math/ops" "add" (func $add (param i32 i32) (result i32)))
    (func (export "run") (result i32)
      (local $head (ref null $node))
      (local.set $head (struct.new $node (i32.const 40) (ref.null $node)))
      (struct.get $node $value (local.get $head))
      (array.len (array.new_default $values (i32.const 2)))
      call $add
      call $tick))
  (core instance $i (instantiate $m
    (with "$root" (instance (export "tick" (func $tick_core))))
    (with "test:math/ops" (instance (export "add" (func $add))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
