;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Exercises every way a handle crosses between components: owned and
;; borrowed parameters, an owned result, owned and borrowed handles inside a
;; list and an owned one inside a result, ownership passed on through a third
;; component, and dropping an owned handle of a resource another component
;; implements. `run` adds up what comes back plus the representations the
;; producer's destructor saw; `misuse` uses a handle after giving it away,
;; which must trap.
(component
  (import "test:res/counters" (instance $counters
    (export "counter" (type $counter (sub resource)))
    (export "make" (func (param "n" u32) (result (own $counter))))
    (export "get" (func (param "c" (borrow $counter)) (result u32)))
    (export "take" (func (param "c" (own $counter)) (result u32)))
    (export "twice" (func (param "c" (borrow $counter)) (result (own $counter))))
    (export "destroyed" (func (result u32)))
    (type $counters (list (own $counter)))
    (export "sum" (func (param "items" $counters) (result u32)))
    (type $borrowed (list (borrow $counter)))
    (export "peek-all" (func (param "items" $borrowed) (result u32)))
    (type $opened (result (own $counter) (error u32)))
    (export "open" (func (param "n" u32) (result $opened)))))
  (alias export $counters "counter" (type $counter))
  (import "test:res/relay" (instance $relay
    (export "relay" (func (param "c" (borrow $counter)) (result u32)))
    (export "relay-own" (func (param "c" (own $counter)) (result u32)))))
  (core module $mem
    (memory (export "memory") 1)
    (global $heap (mut i32) (i32.const 4096))
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32) (local $at i32)
      global.get $heap
      i32.const 7
      i32.add
      i32.const -8
      i32.and
      local.tee $at
      local.get 3
      i32.add
      global.set $heap
      local.get $at))
  (core instance $mi (instantiate $mem))
  (alias core export $mi "memory" (core memory $memory))
  (alias core export $mi "cabi_realloc" (core func $realloc))
  (core func $make (canon lower (func $counters "make")))
  (core func $get (canon lower (func $counters "get")))
  (core func $take (canon lower (func $counters "take")))
  (core func $twice (canon lower (func $counters "twice")))
  (core func $destroyed (canon lower (func $counters "destroyed")))
  (core func $sum (canon lower (func $counters "sum") (memory $memory) (realloc $realloc)))
  (core func $peek_all (canon lower (func $counters "peek-all") (memory $memory) (realloc $realloc)))
  (core func $open (canon lower (func $counters "open") (memory $memory)))
  (core func $drop (canon resource.drop $counter))
  (core func $relay_fn (canon lower (func $relay "relay")))
  (core func $relay_own (canon lower (func $relay "relay-own")))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "test:res/counters" "make" (func $make (param i32) (result i32)))
    (import "test:res/counters" "get" (func $get (param i32) (result i32)))
    (import "test:res/counters" "take" (func $take (param i32) (result i32)))
    (import "test:res/counters" "twice" (func $twice (param i32) (result i32)))
    (import "test:res/counters" "destroyed" (func $destroyed (result i32)))
    (import "test:res/counters" "sum" (func $sum (param i32 i32) (result i32)))
    (import "test:res/counters" "peek-all" (func $peek_all (param i32 i32) (result i32)))
    (import "test:res/counters" "open" (func $open (param i32 i32)))
    (import "test:res/counters" "[resource-drop]counter" (func $drop (param i32)))
    (import "test:res/relay" "relay" (func $relay (param i32) (result i32)))
    (import "test:res/relay" "relay-own" (func $relay_own (param i32) (result i32)))
    (func (export "run") (result i32) (local $a i32) (local $b i32) (local $total i32)
      ;; get(a) on a fresh counter 5
      i32.const 5
      call $make
      local.tee $a
      call $get
      local.set $total
      ;; twice(a) = a new counter 10, relayed as a borrow through a third party
      local.get $a
      call $twice
      local.tee $b
      call $relay
      local.get $total
      i32.add
      local.set $total
      ;; peek-all([a, b]) borrows both; they stay usable afterwards
      i32.const 1536
      local.get $a
      i32.store
      i32.const 1540
      local.get $b
      i32.store
      i32.const 1536
      i32.const 2
      call $peek_all
      local.get $total
      i32.add
      local.set $total
      ;; take(a) consumes it: 5 is destroyed
      local.get $a
      call $take
      local.get $total
      i32.add
      local.set $total
      ;; relay-own(b) passes ownership on to take: 10 is destroyed
      local.get $b
      call $relay_own
      local.get $total
      i32.add
      local.set $total
      ;; sum([1, 2]) takes both: 3 is destroyed in total
      i32.const 1024
      i32.const 1
      call $make
      i32.store
      i32.const 1028
      i32.const 2
      call $make
      i32.store
      i32.const 1024
      i32.const 2
      call $sum
      local.get $total
      i32.add
      local.set $total
      ;; open(4) = ok(counter 4), read, then dropped here: 4 is destroyed
      i32.const 4
      i32.const 2048
      call $open
      i32.const 2052
      i32.load
      local.tee $a
      call $get
      local.get $total
      i32.add
      local.set $total
      local.get $a
      call $drop
      ;; open(0) = err(7); the discriminant counts a hundredfold
      i32.const 0
      i32.const 2048
      call $open
      i32.const 2052
      i32.load
      i32.const 2048
      i32.load8_u
      i32.const 100
      i32.mul
      i32.add
      local.get $total
      i32.add
      local.set $total
      ;; 5 + 10 + 15 + 5 + 10 + 3 + 4 + 107, plus 22 destroyed
      local.get $total
      call $destroyed
      i32.add)
    (func (export "misuse") (result i32) (local $a i32)
      i32.const 3
      call $make
      local.tee $a
      call $take
      drop
      local.get $a
      call $get))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "test:res/counters" (instance
      (export "make" (func $make))
      (export "get" (func $get))
      (export "take" (func $take))
      (export "twice" (func $twice))
      (export "destroyed" (func $destroyed))
      (export "sum" (func $sum))
      (export "peek-all" (func $peek_all))
      (export "open" (func $open))
      (export "[resource-drop]counter" (func $drop))))
    (with "test:res/relay" (instance
      (export "relay" (func $relay_fn))
      (export "relay-own" (func $relay_own))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (func $misuse (result u32) (canon lift (core func $i "misuse")))
  (export "run" (func $run))
  (export "misuse" (func $misuse))
)
