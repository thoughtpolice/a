;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A component exported by an instance retains even a two-level outer alias
;; after that instance has finished instantiating.
(component
  (component $factory
    (core module $original
      (func (export "run") (result i32) i32.const 42))
    (component $child
      (component $grandchild
        (alias outer 2 0 (core module $captured))
        (core instance $i (instantiate $captured))
        (func $run (result u32) (canon lift (core func $i "run")))
        (export "run" (func $run)))
      (instance $g (instantiate $grandchild))
      (export "run" (func $g "run")))
    (export "child" (component $child)))
  (instance $f (instantiate $factory))
  (alias export $f "child" (component $escaped))
  (core module $other
    (func (export "run") (result i32) i32.const 7))
  (instance $c (instantiate $escaped))
  (export "run" (func $c "run")))
