;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Transfers whose targets are nested loop headers. Reading a local for one
;; target can add a parameter to another target of the same transfer, and
;; every arm must still end up complete.
(module
  (tag $t)
  (func $g)

  ;; The inner arm is completed first; the outer arm's read grows the inner
  ;; header afterwards.
  (func (export "br_table_inner_before_outer") (param $n i32)
    (local $a i32) (local $b i32)
    loop $outer
      local.get $b
      drop
      loop $inner
        local.get $a
        drop
        local.get $n
        br_table $inner $outer
      end
    end)

  ;; The same shape with the inner header as the default arm.
  (func (export "br_table_default_inner") (param $n i32)
    (local $a i32) (local $b i32)
    loop $outer
      local.get $b
      drop
      loop $inner
        local.get $a
        drop
        local.get $n
        br_table $outer $inner
      end
    end)

  ;; $b changes in the inner loop, so both headers keep a parameter for it.
  (func (export "br_table_carries_nested_loop_locals") (param $n i32)
    (local $a i32) (local $b i32)
    loop $outer
      local.get $b
      drop
      loop $inner
        local.get $a
        drop
        local.get $b
        i32.const 1
        i32.add
        local.set $b
        local.get $n
        br_table $inner $outer
      end
    end)

  ;; The first catch arm targets the inner header; the second arm's read of
  ;; $y grows the inner header afterwards.
  (func (export "call_routes_to_nested_loop_labels")
    (local $y i32)
    loop $outer
      local.get $y
      drop
      loop $inner
        try_table (catch $t $inner) (catch_all $outer)
          call $g
        end
      end
    end)

  ;; $y is first read at the routing point and changes before the backedge,
  ;; so both headers keep a parameter for it.
  (func (export "call_routes_carry_nested_loop_locals")
    (local $y i32)
    loop $outer
      local.get $y
      drop
      loop $inner
        try_table (catch $t $inner) (catch_all $outer)
          call $g
        end
        local.get $y
        i32.const 1
        i32.add
        local.set $y
        br $inner
      end
    end))
