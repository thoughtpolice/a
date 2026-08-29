;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A catch clause after catch_all is valid Core WebAssembly. It can never be
;; selected, so routing stops at the catch_all and the clause stays as dead
;; source structure.
(module
  (tag $t)
  (func $f)
  (func (export "catch_after_catch_all")
    block $all
      block $tagged
        try_table (catch_all $all) (catch $t $tagged)
          call $f
        end
      end
    end))
