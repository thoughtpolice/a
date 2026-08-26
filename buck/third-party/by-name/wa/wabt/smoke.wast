;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (func (export "answer") (result i32)
    i32.const 42))
(assert_return (invoke "answer") (i32.const 42))
