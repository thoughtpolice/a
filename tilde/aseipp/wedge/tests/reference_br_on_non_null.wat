;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "refine_taken")
      (param $value externref)
      (result (ref extern))
    block $was_non_null (result (ref extern))
      local.get $value
      br_on_non_null $was_non_null
      unreachable
    end))
