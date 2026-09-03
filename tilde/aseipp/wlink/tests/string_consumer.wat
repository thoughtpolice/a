;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Imports test:greet/api. Its memory lives in a module of its own so the
;; lowered imports can name it before the code module is instantiated.
(component
  (import "test:greet/api" (instance $api
    (export "greet" (func (param "name" string) (result u32)))
    (export "name" (func (result string)))))
  (core module $mem
    (memory (export "memory") 1)
    (data (i32.const 16) "hello")
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      i32.const 2048))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (alias core export $mi "cabi_realloc" (core func $realloc))
  (core func $greet (canon lower (func $api "greet") (memory $memory) string-encoding=utf8))
  (core func $name (canon lower (func $api "name") (memory $memory) (realloc $realloc)
    string-encoding=utf8))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:greet/api" "greet" (func $greet (param i32 i32) (result i32)))
    (import "test:greet/api" "name" (func $name (param i32)))
    (func (export "run") (result i32)
      i32.const 16
      i32.const 5
      call $greet)
    (func (export "run_name") (result i32)
      i32.const 64
      call $name
      ;; length plus the first byte of the copied string: 5 + 'w'.
      i32.const 68
      i32.load
      i32.const 64
      i32.load
      i32.load8_u
      i32.add))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:greet/api" (instance
      (export "greet" (func $greet))
      (export "name" (func $name))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (func $run_name (result u32) (canon lift (core func $i "run_name")))
  (export "run" (func $run))
  (export "run-name" (func $run_name))
)
