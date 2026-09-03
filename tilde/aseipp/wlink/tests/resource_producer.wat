;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Implements a `counter` resource whose representation is a plain number.
;; The destructor lives in its own module so the resource type can name it
;; before the main module, which needs the resource built-ins, is
;; instantiated; it adds every destroyed representation to a shared global.
(component
  (core module $d
    (global $destroyed (export "destroyed") (mut i32) (i32.const 0))
    (func (export "dtor") (param i32)
      global.get $destroyed
      local.get 0
      i32.add
      global.set $destroyed))
  (core instance $di (instantiate $d))
  (type $counter (resource (rep i32) (dtor (core func $di "dtor"))))
  (core func $new (canon resource.new $counter))
  (core func $rep (canon resource.rep $counter))
  (core func $drop (canon resource.drop $counter))
  (core module $m
    (import "env" "destroyed" (global $destroyed (mut i32)))
    (import "[export]test:res/counters" "[resource-new]counter" (func $new (param i32) (result i32)))
    (import "[export]test:res/counters" "[resource-rep]counter" (func $rep (param i32) (result i32)))
    (import "[export]test:res/counters" "[resource-drop]counter" (func $drop (param i32)))
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
      local.get $at)
    (func (export "make") (param i32) (result i32)
      local.get 0
      call $new)
    ;; A borrowed handle arrives as the representation itself.
    (func (export "get") (param i32) (result i32)
      local.get 0)
    ;; An owned handle arrives as a handle; taking it consumes it.
    (func (export "take") (param i32) (result i32) (local $value i32)
      local.get 0
      call $rep
      local.set $value
      local.get 0
      call $drop
      local.get $value)
    (func (export "twice") (param i32) (result i32)
      local.get 0
      i32.const 2
      i32.mul
      call $new)
    (func (export "destroyed") (result i32)
      global.get $destroyed)
    ;; sum(items): takes ownership of every counter in the list.
    (func (export "sum") (param $ptr i32) (param $len i32) (result i32)
      (local $i i32) (local $handle i32) (local $total i32)
      block $done
        loop $next
          local.get $i
          local.get $len
          i32.ge_u
          br_if $done
          local.get $ptr
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          i32.load
          local.tee $handle
          call $rep
          local.get $total
          i32.add
          local.set $total
          local.get $handle
          call $drop
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end
      local.get $total)
    ;; peek-all(items): borrowed counters arrive as their representations.
    (func (export "peek-all") (param $ptr i32) (param $len i32) (result i32)
      (local $i i32) (local $total i32)
      block $done
        loop $next
          local.get $i
          local.get $len
          i32.ge_u
          br_if $done
          local.get $ptr
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          i32.load
          local.get $total
          i32.add
          local.set $total
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end
      local.get $total)
    ;; open(n): ok(counter n) for a nonzero n, else err(7), in a fixed area.
    (func (export "open") (param $n i32) (result i32)
      local.get $n
      if
        i32.const 512
        i32.const 0
        i32.store8
        i32.const 516
        local.get $n
        call $new
        i32.store
      else
        i32.const 512
        i32.const 1
        i32.store8
        i32.const 516
        i32.const 7
        i32.store
      end
      i32.const 512))
  (core instance $i (instantiate $m
    (with "env" (instance (export "destroyed" (global $di "destroyed"))))
    (with "[export]test:res/counters" (instance
      (export "[resource-new]counter" (func $new))
      (export "[resource-rep]counter" (func $rep))
      (export "[resource-drop]counter" (func $drop))))))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "cabi_realloc" (core func $realloc))
  (func $make (param "n" u32) (result (own $counter)) (canon lift (core func $i "make")))
  (func $get (param "c" (borrow $counter)) (result u32) (canon lift (core func $i "get")))
  (func $take (param "c" (own $counter)) (result u32) (canon lift (core func $i "take")))
  (func $twice (param "c" (borrow $counter)) (result (own $counter)) (canon lift (core func $i "twice")))
  (func $destroyed (result u32) (canon lift (core func $i "destroyed")))
  (type $counters (list (own $counter)))
  (func $sum (param "items" $counters) (result u32)
    (canon lift (core func $i "sum") (memory $memory) (realloc $realloc)))
  (type $borrowed (list (borrow $counter)))
  (func $peek_all (param "items" $borrowed) (result u32)
    (canon lift (core func $i "peek-all") (memory $memory) (realloc $realloc)))
  (type $opened (result (own $counter) (error u32)))
  (func $open (param "n" u32) (result $opened)
    (canon lift (core func $i "open") (memory $memory)))
  (instance $exports
    (export "counter" (type $counter))
    (export "make" (func $make))
    (export "get" (func $get))
    (export "take" (func $take))
    (export "twice" (func $twice))
    (export "destroyed" (func $destroyed))
    (export "sum" (func $sum))
    (export "peek-all" (func $peek_all))
    (export "open" (func $open)))
  (export "test:res/counters" (instance $exports))
)
