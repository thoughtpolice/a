;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "refine_fallthrough")
      (param $value externref)
      (result (ref extern))
    block $was_null
      local.get $value
      br_on_null $was_null
      return
    end
    unreachable))
