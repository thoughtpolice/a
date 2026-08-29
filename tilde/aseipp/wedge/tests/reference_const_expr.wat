;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $callback (func (result i32)))
  (import "host" "callback" (func $callback (type $callback)))
  (table (export "callbacks") 1 funcref (ref.func $callback)))
