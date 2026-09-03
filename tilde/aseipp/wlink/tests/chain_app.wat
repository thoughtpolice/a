;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The top of the chain. run sends "hey" from this memory through mid into
;; base.
(component
  (import "test:chain/mid" (instance $mid
    (export "relay" (func (param "text" string) (result u32)))))
  (core module $mem
    (memory (export "memory") 1)
    (data (i32.const 16) "hey"))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (core func $relay (canon lower (func $mid "relay") (memory $memory) string-encoding=utf8))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:chain/mid" "relay" (func $relay (param i32 i32) (result i32)))
    (func (export "run") (result i32)
      i32.const 16
      i32.const 3
      call $relay))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:chain/mid" (instance (export "relay" (func $relay))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)
