;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The middle of the chain: relay hands the string it received on to base,
;; so the text is copied twice, into this memory and then out of it.
(component
  (import "test:chain/base" (instance $base
    (export "shout" (func (param "text" string) (result u32)))))
  (core module $mem
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
      local.get $ptr))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (alias core export $mi "cabi_realloc" (core func $realloc))
  (core func $shout (canon lower (func $base "shout") (memory $memory) string-encoding=utf8))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:chain/base" "shout" (func $shout (param i32 i32) (result i32)))
    (func (export "relay") (param i32 i32) (result i32)
      local.get 0
      local.get 1
      call $shout
      i32.const 1000
      i32.add))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:chain/base" (instance (export "shout" (func $shout))))))
  (func $relay (param "text" string) (result u32)
    (canon lift (core func $i "relay") (memory $memory) (realloc $realloc) string-encoding=utf8))
  (instance $exports (export "relay" (func $relay)))
  (export "test:chain/mid" (instance $exports))
)
