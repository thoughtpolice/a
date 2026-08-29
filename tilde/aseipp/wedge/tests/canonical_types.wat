;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $first (func))
  (type $second (func))
  (type $producer (func (result (ref null $first))))

  (func $second_instance (type $second))
  (elem declare func $second_instance)

  ;; wasmparser canonicalizes the two structurally equivalent declarations to
  ;; one CoreTypeId even though they retain distinct module type indices.
  (func (export "equivalent_function") (type $producer)
    ref.func $second_instance)
)
