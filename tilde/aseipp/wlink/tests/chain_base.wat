;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The bottom of a three-component chain. shout returns the length of a
;; string plus its first byte, read from the copy in this memory.
(component
  (core module $m
    (memory (export "memory") 1)
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
    (func (export "shout") (param i32 i32) (result i32)
      local.get 0
      i32.load8_u
      local.get 1
      i32.add))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "cabi_realloc" (core func $realloc))
  (func $shout (param "text" string) (result u32)
    (canon lift (core func $i "shout") (memory $memory) (realloc $realloc) string-encoding=utf8))
  (instance $exports (export "shout" (func $shout)))
  (export "test:chain/base" (instance $exports))
)
