;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $pair-to-one (func (param i32 i32) (result i32)))
  (type $identity (func (param i32) (result i32)))

  ;; The loop label consumes its parameter types, while normal fallthrough
  ;; produces the distinct result type list.
  (func (export "typed_loop") (param $condition i32) (result i32)
    i32.const 10
    i32.const 20
    loop (type $pair-to-one)
      local.get $condition
      br_if 0
      drop
    end)

  (func (export "if_else") (param $condition i32) (result i32)
    local.get $condition
    if (result i32)
      i32.const 11
    else
      i32.const 22
    end)

  ;; An omitted else arm is an implicit identity for a valid (T -> T) if.
  (func (export "implicit_else")
    (param $condition i32)
    (param $value i32)
    (result i32)
    local.get $value
    local.get $condition
    if (type $identity)
    end)

  ;; Depth zero at function scope names the implicit function label.
  (func (export "function_branch") (result i32)
    i32.const 4
    br 0)

  ;; The branch makes every following nested construct dead, but the outer
  ;; result continuation remains reachable.
  (func (export "nested_dead") (result i32)
    block $outer (result i32)
      i32.const 8
      br $outer
      block
        loop
          br 0
        end
      end
      unreachable
    end)

  ;; Values below a block's input height survive branches to its label.
  (func (export "branch_prefix") (result i32)
    i32.const 5
    block $skip
      br $skip
      unreachable
    end
    i32.const 7
    i32.add)

  ;; A structured result and a local merge occupy distinct parameters on the
  ;; same continuation block.
  (func (export "mixed_join") (param $condition i32) (result i32 i32)
    (local $value i32)
    block $join (result i32)
      i32.const 1
      local.set $value
      i32.const 10
      local.get $condition
      br_if $join
      drop
      i32.const 2
      local.set $value
      i32.const 20
    end
    local.get $value)

  ;; Keep a nested block and both if arms reachable so their structured region
  ;; hierarchy and two typed joins survive into the owned CFG.
  (func (export "nested_reachable")
    (param $condition i32)
    (param $value i32)
    (result i32)
    local.get $value
    block (type $identity)
      local.get $condition
      if (type $identity)
        i32.const 1
        i32.add
      else
        i32.const 2
        i32.add
      end
    end))
