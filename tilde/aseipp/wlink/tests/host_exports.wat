;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The host needs the lift's memory, allocator, and post-return callback.
(component
  (core module $m
    (memory (export "memory") 1)
    (data (i32.const 16) "abc")
    (global $returns (mut i32) (i32.const 0))
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      i32.const 512)
    (func (export "name") (result i32)
      i32.const 0 i32.const 16 i32.store
      i32.const 4 i32.const 3 i32.store
      i32.const 0)
    (func (export "post-name") (param i32)
      i32.const 16 i32.const 0 i32.store8
      global.get $returns i32.const 1 i32.add global.set $returns)
    (func (export "count") (result i32) global.get $returns)
    (func (export "greet") (param i32 i32) (result i32)
      local.get 0 i32.load8_u))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "realloc" (core func $realloc))
  (alias core export $i "post-name" (core func $post))
  (func $name (result string)
    (canon lift (core func $i "name") (memory $memory) (post-return $post)))
  (func $count (result u32) (canon lift (core func $i "count")))
  (func $greet (param "message" string) (result u32)
    (canon lift (core func $i "greet") (memory $memory) (realloc $realloc)))
  (export "name" (func $name))
  (export "count" (func $count))
  (export "greet" (func $greet)))
