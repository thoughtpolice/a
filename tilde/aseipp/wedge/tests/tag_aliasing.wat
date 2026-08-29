;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Two imported tags with equivalent types may be one tag instance at run
;; time, so a throw of one may be caught by a clause naming the other. A
;; defined tag is a fresh instance and never aliases an import.
(module
  (import "env" "t" (tag $t1 (param i32)))
  (import "env" "t" (tag $t2 (param i32)))
  (import "env" "u" (tag $wide (param i64)))
  (tag $local (param i32))

  (func (export "possible_alias") (param $v i32) (result i32)
    block $h (result i32)
      try_table (catch $t2 $h)
        local.get $v
        throw $t1
      end
      unreachable
    end)

  (func (export "possible_then_definite") (param $v i32) (result i32)
    block $h1 (result i32)
      block $h2 (result i32)
        try_table (catch $t2 $h1) (catch $t1 $h2)
          local.get $v
          throw $t1
        end
        unreachable
      end
    end)

  (func (export "different_type_no_alias") (param $v i32)
    block $h (result i64)
      try_table (catch $wide $h)
        local.get $v
        throw $t1
      end
      unreachable
    end
    drop)

  (func (export "defined_no_alias") (param $v i32)
    block $h (result i32)
      try_table (catch $local $h)
        local.get $v
        throw $t1
      end
      unreachable
    end
    drop)

  (func (export "possible_then_catch_all") (param $v i32) (result i32)
    block $h (result i32)
      block $all
        try_table (catch $t2 $h) (catch_all $all)
          local.get $v
          throw $t1
        end
        unreachable
      end
      i32.const 0
    end))
