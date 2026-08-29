;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (tag $failure (param i32))
  (tag $empty)
  (func $raise (param $payload i32)
    local.get $payload
    throw $failure)

  (func (export "catch") (param $payload i32) (result i32)
    block $caught (result i32)
      try_table (result i32) (catch $failure $caught)
        local.get $payload
        call $raise
        i32.const -1
      end
    end)

  ;; The final exception-handling design carries first-class exception
  ;; references through catch_ref and rethrows them with throw_ref.
  (func (export "catch_and_rethrow")
    block $caught (result exnref)
      try_table (catch_ref $empty $caught)
        throw $empty
      end
      unreachable
    end
    throw_ref))
