;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Resource handles that reach the host through memory. The host implements
;; `item`; this component keeps its handles in an array and passes them to
;; the host inside a list, inside a list of records, and in a parameter
;; list wide enough to spill, so every handle the host reads is a word of
;; this component's memory. The wasm2c host test checks that those words
;; hold representations during a call and the handles again afterwards, and
;; that a borrowed handle stays lent while the host holds it.
(component
  (import "host:res/pool" (instance $pool
    (export "item" (type $item (sub resource)))
    (export "open" (func (param "id" u32) (result (own $item))))
    (type $borrowed (list (borrow $item)))
    (export "sum-all" (func (param "items" $borrowed) (result u32)))
    (type $owned (list (own $item)))
    (export "take-all" (func (param "items" $owned) (result u32)))
    (export "wide" (func
      (param "a" u32) (param "b" u32) (param "c" u32) (param "d" u32)
      (param "e" u32) (param "f" u32) (param "g" u32) (param "h" u32)
      (param "i" u32) (param "j" u32) (param "k" u32) (param "l" u32)
      (param "m" u32) (param "n" u32) (param "o" u32) (param "p" u32)
      (param "which" (borrow $item)) (result u32)))
    (type $row_def (record (field "id" u32) (field "which" (borrow $item))))
    (export "row" (type $row (eq $row_def)))
    (type $rows (list $row))
    (export "describe" (func (param "rows" $rows) (result u32)))))
  (alias export $pool "item" (type $item))
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
  (core func $open (canon lower (func $pool "open")))
  (core func $sum_all (canon lower (func $pool "sum-all") (memory $memory) (realloc $realloc)))
  (core func $take_all (canon lower (func $pool "take-all") (memory $memory) (realloc $realloc)))
  (core func $wide (canon lower (func $pool "wide") (memory $memory) (realloc $realloc)))
  (core func $describe (canon lower (func $pool "describe") (memory $memory) (realloc $realloc)))
  (core func $drop (canon resource.drop $item))
  (core module $m
    (import "env" "memory" (memory 1))
    (import "host:res/pool" "open" (func $open (param i32) (result i32)))
    (import "host:res/pool" "sum-all" (func $sum_all (param i32 i32) (result i32)))
    (import "host:res/pool" "take-all" (func $take_all (param i32 i32) (result i32)))
    (import "host:res/pool" "wide" (func $wide (param i32) (result i32)))
    (import "host:res/pool" "describe" (func $describe (param i32 i32) (result i32)))
    (import "host:res/pool" "[resource-drop]item" (func $drop (param i32)))
    ;; pool-fill(n): opens items 1..n into the array at 1024.
    (func (export "pool-fill") (param $n i32) (local $i i32)
      block $done
        loop $next
          local.get $i
          local.get $n
          i32.ge_u
          br_if $done
          i32.const 1024
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          local.get $i
          i32.const 1
          i32.add
          call $open
          i32.store
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end)
    ;; pool-sum(n): sum-all over the first n handles of the array.
    (func (export "pool-sum") (param $n i32) (result i32)
      i32.const 1024
      local.get $n
      call $sum_all)
    ;; pool-describe(n): rows at 2048 pairing 100 * (i + 1) with array[i].
    (func (export "pool-describe") (param $n i32) (result i32) (local $i i32) (local $row i32)
      block $done
        loop $next
          local.get $i
          local.get $n
          i32.ge_u
          br_if $done
          i32.const 2048
          local.get $i
          i32.const 8
          i32.mul
          i32.add
          local.tee $row
          local.get $i
          i32.const 1
          i32.add
          i32.const 100
          i32.mul
          i32.store
          local.get $row
          i32.const 1024
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          i32.load
          i32.store offset=4
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end
      i32.const 2048
      local.get $n
      call $describe)
    ;; pool-wide(): the numbers 1..16 and then array[1] in a record at 3072.
    (func (export "pool-wide") (result i32) (local $i i32)
      block $done
        loop $next
          local.get $i
          i32.const 16
          i32.ge_u
          br_if $done
          i32.const 3072
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          local.get $i
          i32.const 1
          i32.add
          i32.store
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end
      i32.const 3136
      i32.const 1028
      i32.load
      i32.store
      i32.const 3072
      call $wide)
    ;; pool-take-from(offset, n): take-all over array[offset..offset + n].
    (func (export "pool-take-from") (param $offset i32) (param $n i32) (result i32)
      i32.const 1024
      local.get $offset
      i32.const 4
      i32.mul
      i32.add
      local.get $n
      call $take_all)
    ;; pool-drop(i): drops array[i], which must not be lent out.
    (func (export "pool-drop") (param $i i32)
      i32.const 1024
      local.get $i
      i32.const 4
      i32.mul
      i32.add
      i32.load
      call $drop))
  (core instance $i (instantiate $m
    (with "env" (instance (export "memory" (memory $memory))))
    (with "host:res/pool" (instance
      (export "open" (func $open))
      (export "sum-all" (func $sum_all))
      (export "take-all" (func $take_all))
      (export "wide" (func $wide))
      (export "describe" (func $describe))
      (export "[resource-drop]item" (func $drop))))))
  (func $fill (param "n" u32) (canon lift (core func $i "pool-fill")))
  (func $sum (param "n" u32) (result u32) (canon lift (core func $i "pool-sum")))
  (func $describe_rows (param "n" u32) (result u32) (canon lift (core func $i "pool-describe")))
  (func $wide_call (result u32) (canon lift (core func $i "pool-wide")))
  (func $take_from (param "offset" u32) (param "n" u32) (result u32)
    (canon lift (core func $i "pool-take-from")))
  (func $drop_at (param "i" u32) (canon lift (core func $i "pool-drop")))
  (export "pool-fill" (func $fill))
  (export "pool-sum" (func $sum))
  (export "pool-describe" (func $describe_rows))
  (export "pool-wide" (func $wide_call))
  (export "pool-take-from" (func $take_from))
  (export "pool-drop" (func $drop_at))
)
