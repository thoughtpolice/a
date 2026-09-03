;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Forwards handles of a resource it does not implement. A borrowed handle
;; arrives in this component's own table, is lent on to the implementor, and
;; must be dropped again before the call returns; an owned handle is handed
;; on for good.
(component
  (import "test:res/counters" (instance $counters
    (export "counter" (type $counter (sub resource)))
    (export "get" (func (param "c" (borrow $counter)) (result u32)))
    (export "take" (func (param "c" (own $counter)) (result u32)))))
  (alias export $counters "counter" (type $counter))
  (core func $get (canon lower (func $counters "get")))
  (core func $take (canon lower (func $counters "take")))
  (core func $drop (canon resource.drop $counter))
  (core module $m
    (import "test:res/counters" "get" (func $get (param i32) (result i32)))
    (import "test:res/counters" "take" (func $take (param i32) (result i32)))
    (import "test:res/counters" "[resource-drop]counter" (func $drop (param i32)))
    (func (export "relay") (param i32) (result i32) (local $value i32)
      local.get 0
      call $get
      local.set $value
      local.get 0
      call $drop
      local.get $value)
    (func (export "relay-own") (param i32) (result i32)
      local.get 0
      call $take))
  (core instance $i (instantiate $m
    (with "test:res/counters" (instance
      (export "get" (func $get))
      (export "take" (func $take))
      (export "[resource-drop]counter" (func $drop))))))
  (func $relay (param "c" (borrow $counter)) (result u32) (canon lift (core func $i "relay")))
  (func $relay_own (param "c" (own $counter)) (result u32) (canon lift (core func $i "relay-own")))
  (instance $exports
    (export "relay" (func $relay))
    (export "relay-own" (func $relay_own)))
  (export "test:res/relay" (instance $exports))
)
