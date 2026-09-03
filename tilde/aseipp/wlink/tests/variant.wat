;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A producer whose interface uses bool, option, an enum, and a result,
;; composed with its consumer in one component. Everything but the result
;; flattens to a few i32s and binds directly; result<u32, u32> is two flat
;; values and spills through memory.
(component
  (component $producer
    (core module $m
      (memory (export "memory") 1)
      ;; pick(which, some, value, level): value when which and some, else
      ;; the level.
      (func (export "pick") (param i32 i32 i32 i32) (result i32)
        local.get 0
        local.get 1
        i32.and
        if (result i32)
          local.get 2
        else
          local.get 3
        end)
      ;; status(n): ok(n) for even n, err(n) for odd, in a fixed return area.
      (func (export "status") (param i32) (result i32)
        i32.const 64
        local.get 0
        i32.const 1
        i32.and
        i32.store
        i32.const 68
        local.get 0
        i32.store
        i32.const 64))
    (core instance $i (instantiate $m))
    (alias core export $i "memory" (core memory $memory))
    (type $level (enum "low" "mid" "high"))
    (type $outcome (result u32 (error u32)))
    (func $pick (param "which" bool) (param "value" (option u32)) (param "level" $level) (result u32)
      (canon lift (core func $i "pick")))
    (func $status (param "n" u32) (result $outcome)
      (canon lift (core func $i "status") (memory $memory)))
    (instance $exports
      (export "level" (type $level))
      (export "outcome" (type $outcome))
      (export "pick" (func $pick))
      (export "status" (func $status)))
    (export "test:variant/ops" (instance $exports)))
  (component $consumer
    (import "test:variant/ops" (instance $ops
      (type $level_def (enum "low" "mid" "high"))
      (export "level" (type $level (eq $level_def)))
      (type $outcome_def (result u32 (error u32)))
      (export "outcome" (type $outcome (eq $outcome_def)))
      (export "pick" (func (param "which" bool) (param "value" (option u32)) (param "level" $level) (result u32)))
      (export "status" (func (param "n" u32) (result $outcome)))))
    (core module $mem
      (memory (export "memory") 1))
    (core instance $mi (instantiate $mem))
    (alias core export $mi "memory" (core memory $memory))
    (core func $pick (canon lower (func $ops "pick")))
    (core func $status (canon lower (func $ops "status") (memory $memory)))
    (core module $m
      (import "env" "memory" (memory 1))
      (import "test:variant/ops" "pick" (func $pick (param i32 i32 i32 i32) (result i32)))
      (import "test:variant/ops" "status" (func $status (param i32 i32)))
      (func (export "run") (result i32)
        ;; pick(true, some(40), high) = 40
        i32.const 1
        i32.const 1
        i32.const 40
        i32.const 2
        call $pick
        ;; pick(false, none, high) = 2
        i32.const 0
        i32.const 0
        i32.const 0
        i32.const 2
        call $pick
        i32.add
        ;; status(7) = err(7): discriminant 1 at 128, payload 7 at 132
        i32.const 7
        i32.const 128
        call $status
        i32.const 128
        i32.load
        i32.add
        ;; 40 + 2 + 1, less one for the payload arriving intact
        i32.const 132
        i32.load
        i32.const 7
        i32.eq
        i32.sub))
    (core instance $i (instantiate $m
      (with "env" (instance (export "memory" (memory $memory))))
      (with "test:variant/ops" (instance
        (export "pick" (func $pick))
        (export "status" (func $status))))))
    (func $run (result u32) (canon lift (core func $i "run")))
    (export "run" (func $run)))
  (instance $p (instantiate $producer))
  (instance $c (instantiate $consumer (with "test:variant/ops" (instance $p "test:variant/ops"))))
  (export "run" (func $c "run"))
)
