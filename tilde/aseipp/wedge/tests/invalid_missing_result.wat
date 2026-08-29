;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; WABT emits this with --no-check so wasmparser remains the authoritative
;; semantic validation boundary in the Wedge pipeline.
(module
  (func (export "missing_result") (result i32)))
