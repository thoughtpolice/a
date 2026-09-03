;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Exports greet, which takes a string and returns its length, and name,
;; which returns a string through a post-return.
(component
  (core module $m
    (memory (export "memory") 1)
    (data (i32.const 32) "wlink")
    (global $bump (mut i32) (i32.const 1024))
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (local $ptr i32)
      global.get $bump
      local.set $ptr
      global.get $bump
      local.get 3
      i32.add
      global.set $bump
      local.get $ptr)
    (func (export "greet") (param i32 i32) (result i32)
      ;; The adapter copied the argument here, so its first byte is readable.
      local.get 0
      i32.load8_u
      i32.const 104 ;; 'h'
      i32.ne
      if
        unreachable
      end
      local.get 1)
    (func (export "name") (result i32)
      i32.const 8
      i32.const 32
      i32.store
      i32.const 12
      i32.const 5
      i32.store
      i32.const 8)
    (global $post_returns (export "post_returns") (mut i32) (i32.const 0))
    (func (export "post_name") (param i32)
      global.get $post_returns
      i32.const 1
      i32.add
      global.set $post_returns))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "cabi_realloc" (core func $realloc))
  (alias core export $i "post_name" (core func $post_name))
  (func $greet (param "name" string) (result u32)
    (canon lift (core func $i "greet") (memory $memory) (realloc $realloc) string-encoding=utf8))
  (func $name (result string)
    (canon lift (core func $i "name") (memory $memory) (realloc $realloc) (post-return $post_name)
      string-encoding=utf8))
  (instance $exports
    (export "greet" (func $greet))
    (export "name" (func $name)))
  (export "test:greet/api" (instance $exports))
)
