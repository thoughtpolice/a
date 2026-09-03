;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Exports test:seq/ops. sum takes a list, which the adapter copies in whole;
;; iota returns one through a post-return; total takes a list of lists, whose
;; rows the adapter copies one by one; label returns a string inside an
;; option.
(component
  (core module $m
    (memory (export "memory") 1)
    (data (i32.const 600) "abc")
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
    (func (export "sum") (param $ptr i32) (param $len i32) (result i32)
      (local $acc i32)
      block $done
        loop $next
          local.get $len
          i32.eqz
          br_if $done
          local.get $acc
          local.get $ptr
          i32.load
          i32.add
          local.set $acc
          local.get $ptr
          i32.const 4
          i32.add
          local.set $ptr
          local.get $len
          i32.const 1
          i32.sub
          local.set $len
          br $next
        end
      end
      local.get $acc)
    (func (export "iota") (param $n i32) (result i32)
      (local $i i32)
      ;; The bytes 0..n at 512, described by the pair at 8.
      block $done
        loop $next
          local.get $i
          local.get $n
          i32.ge_u
          br_if $done
          local.get $i
          i32.const 512
          i32.add
          local.get $i
          i32.store8
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $next
        end
      end
      i32.const 8
      i32.const 512
      i32.store
      i32.const 12
      local.get $n
      i32.store
      i32.const 8)
    ;; total(rows): every u32 of every row.
    (func (export "total") (param $rows i32) (param $count i32) (result i32)
      (local $acc i32) (local $ptr i32) (local $len i32)
      block $done
        loop $next_row
          local.get $count
          i32.eqz
          br_if $done
          local.get $rows
          i32.load
          local.set $ptr
          local.get $rows
          i32.load offset=4
          local.set $len
          block $row_done
            loop $next
              local.get $len
              i32.eqz
              br_if $row_done
              local.get $acc
              local.get $ptr
              i32.load
              i32.add
              local.set $acc
              local.get $ptr
              i32.const 4
              i32.add
              local.set $ptr
              local.get $len
              i32.const 1
              i32.sub
              local.set $len
              br $next
            end
          end
          local.get $rows
          i32.const 8
          i32.add
          local.set $rows
          local.get $count
          i32.const 1
          i32.sub
          local.set $count
          br $next_row
        end
      end
      local.get $acc)
    ;; label(n): some("abc") for a nonzero n, else none, in a fixed area.
    (func (export "label") (param $n i32) (result i32)
      i32.const 24
      local.get $n
      i32.const 0
      i32.ne
      i32.store8
      i32.const 28
      i32.const 600
      i32.store
      i32.const 32
      i32.const 3
      i32.store
      i32.const 24)
    (global $post_returns (export "post_returns") (mut i32) (i32.const 0))
    (func (export "post_iota") (param i32)
      global.get $post_returns
      i32.const 1
      i32.add
      global.set $post_returns))
  (core instance $i (instantiate $m))
  (alias core export $i "memory" (core memory $memory))
  (alias core export $i "cabi_realloc" (core func $realloc))
  (alias core export $i "post_iota" (core func $post_iota))
  (func $sum (param "values" (list u32)) (result u32)
    (canon lift (core func $i "sum") (memory $memory) (realloc $realloc)))
  (func $iota (param "n" u32) (result (list u8))
    (canon lift (core func $i "iota") (memory $memory) (realloc $realloc) (post-return $post_iota)))
  (type $rows (list (list u32)))
  (func $total (param "rows" $rows) (result u32)
    (canon lift (core func $i "total") (memory $memory) (realloc $realloc)))
  (type $label (option string))
  (func $label (param "n" u32) (result $label)
    (canon lift (core func $i "label") (memory $memory)))
  (instance $exports
    (export "sum" (func $sum))
    (export "iota" (func $iota))
    (export "total" (func $total))
    (export "label" (func $label)))
  (export "test:seq/ops" (instance $exports))
)
