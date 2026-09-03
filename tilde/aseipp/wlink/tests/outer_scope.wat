;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The child's outer alias refers to its definition site, not its caller.
(component
  (core module $original
    (func (export "run") (result i32) i32.const 42))
  (component $child
    (alias outer 1 0 (core module $captured))
    (core instance $i (instantiate $captured))
    (func $run (result u32) (canon lift (core func $i "run")))
    (export "run" (func $run)))
  (component $wrapper
    (alias outer 1 0 (component $child-alias))
    (core module $other
      (func (export "run") (result i32) i32.const 7))
    (instance $c (instantiate $child-alias))
    (export "run" (func $c "run")))
  (instance $w (instantiate $wrapper))
  (export "run" (func $w "run")))
