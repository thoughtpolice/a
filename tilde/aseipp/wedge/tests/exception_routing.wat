;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $thrower (func (param i32)))
  (tag $a)
  (tag $b)
  (tag $payload (param i32))

  (func $maybe_throw_a (param $throw i32)
    local.get $throw
    if
      throw $a
    end)

  (func $maybe_value (param $throw i32) (result i32)
    local.get $throw
    call $maybe_throw_a
    i32.const 7)

  (func $raise_payload (param $value i32)
    local.get $value
    throw $payload)

  (table $throwers 1 funcref)
  (elem (i32.const 0) func $maybe_throw_a)

  ;; The only reachable read of $state is entered exceptionally.
  (func (export "exceptional_only_local") (param $seed i32) (result i32)
    (local $state i32)
    local.get $seed
    local.set $state
    block $caught
      try_table (catch $a $caught)
        i32.const 1
        call $maybe_throw_a
        unreachable
      end
      unreachable
    end
    local.get $state)

  ;; The block continuation merges 22 from normal completion with 11 from
  ;; the exceptional call edge.
  (func (export "mixed_local") (param $throw i32) (result i32)
    (local $state i32)
    block $caught
      try_table (catch $a $caught)
        i32.const 11
        local.set $state
        local.get $throw
        call $maybe_throw_a
        i32.const 22
        local.set $state
      end
    end
    local.get $state)

  ;; Two exceptional points in one lexical try snapshot different definitions
  ;; of the same local and therefore become distinct SSA predecessors.
  (func (export "two_exception_points")
      (param $first i32) (param $second i32) (result i32)
    (local $state i32)
    block $caught
      try_table (catch $a $caught)
        i32.const 10
        local.set $state
        local.get $first
        call $maybe_throw_a
        i32.const 20
        local.set $state
        local.get $second
        call $maybe_throw_a
        i32.const 30
        local.set $state
      end
    end
    local.get $state)

  ;; The call result exists only on the compiler-created normal continuation;
  ;; the handler instead observes the local's default value.
  (func (export "normal_only_call_result") (param $throw i32) (result i32)
    (local $result i32)
    block $caught
      try_table (catch $a $caught)
        local.get $throw
        call $maybe_value
        local.set $result
      end
    end
    local.get $result)

  ;; Dynamic calls retain every ordered clause until catch_all.
  (func (export "multiple_clauses") (param $throw i32)
    block $caught
      try_table
          (catch $a $caught)
          (catch $b $caught)
          (catch_all $caught)
        local.get $throw
        call $maybe_throw_a
      end
    end)

  (func (export "indirect_call") (param $throw i32)
    block $caught
      try_table (catch $a $caught)
        local.get $throw
        i32.const 0
        call_indirect $throwers (type $thrower)
      end
    end)

  (func (export "reference_call") (param $throw i32)
    block $caught
      try_table (catch $a $caught)
        local.get $throw
        ref.func $maybe_throw_a
        call_ref $thrower
      end
    end)

  (func (export "catch_ref_call") (result exnref)
    block $caught (result exnref)
      try_table (catch_ref $a $caught)
        i32.const 1
        call $maybe_throw_a
        unreachable
      end
      unreachable
    end)

  (func (export "caught_payload_call") (param $value i32) (result i32)
    block $caught (result i32)
      try_table (catch $payload $caught)
        local.get $value
        call $raise_payload
        unreachable
      end
      unreachable
    end)

  (func (export "catch_all_ref_call") (result exnref)
    block $caught (result exnref)
      try_table (catch_all_ref $caught)
        i32.const 1
        call $maybe_throw_a
        unreachable
      end
      unreachable
    end)

  ;; A dynamic exception first tests the inner tag, then falls back to the
  ;; outer handler before it is allowed to escape.
  (func (export "nested_fallback") (param $throw i32)
    block $outer_caught
      try_table (catch $b $outer_caught)
        block $inner_caught
          try_table (catch $a $inner_caught)
            local.get $throw
            call $maybe_throw_a
          end
        end
      end
    end)

  ;; A statically known throw skips non-matching clauses, carries its existing
  ;; payload SSA value, and snapshots a local after the catch payload prefix.
  (func (export "known_throw_payload_and_local")
      (param $value i32) (param $state i32) (result i32 i32)
    (local $saved i32)
    local.get $state
    local.set $saved
    block $caught (result i32)
      try_table (catch $payload $caught)
        local.get $value
        throw $payload
      end
      unreachable
    end
    local.get $saved))
