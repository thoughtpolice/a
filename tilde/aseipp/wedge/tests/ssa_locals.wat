;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $ft (func))

  ;; Parameters are definitions at function entry, rather than implicit reads
  ;; from a mutable local store.
  (func (export "parameters")
    (param i32 i64 f32 f64 v128 externref funcref)
    (result i32 i64 f32 f64 v128 externref funcref)
    local.get 0
    local.get 1
    local.get 2
    local.get 3
    local.get 4
    local.get 5
    local.get 6)

  ;; local.tee aliases its input in SSA; it must not manufacture a copy.
  (func (export "local_tee") (param $value i32) (result i32)
    (local $copy i32)
    local.get $value
    local.tee $copy
    i32.const 1
    i32.add)

  ;; SSA values retain their precise type when flowing through a local whose
  ;; declared type is a supertype. No widening instruction is necessary.
  (func (export "widen_reference_local")
    (param $value (ref $ft))
    (result funcref)
    (local $widened funcref)
    local.get $value
    local.set $widened
    local.get $widened)

  ;; The two definitions of $answer require a block parameter at the join.
  (func (export "if_else_local") (param $condition i32) (result i32)
    (local $answer i32)
    local.get $condition
    if
      i32.const 11
      local.set $answer
    else
      i32.const 22
      local.set $answer
    end
    local.get $answer)

  ;; Both incoming paths carry the same definition. A temporary merge created
  ;; during sealed-block construction should therefore disappear as trivial.
  (func (export "if_same_local")
    (param $condition i32)
    (param $value i32)
    (result i32)
    local.get $condition
    if
      nop
    else
      nop
    end
    local.get $value)

  ;; A read in a block with one predecessor resolves recursively and needs no
  ;; block parameter.
  (func (export "single_predecessor") (param $input i32) (result i32)
    (local $value i32)
    local.get $input
    local.set $value
    block $done
      br $done
    end
    local.get $value)

  ;; Both $remaining and $sum are loop-carried SSA values. The loop header
  ;; needs entry and backedge arguments for each of them.
  (func (export "loop_carried_locals") (param $remaining i32) (result i32)
    (local $sum i32)
    block $exit
      loop $again
        local.get $remaining
        i32.eqz
        br_if $exit

        local.get $sum
        local.get $remaining
        i32.add
        local.set $sum

        local.get $remaining
        i32.const 1
        i32.sub
        local.set $remaining
        br $again
      end
    end
    local.get $sum))
