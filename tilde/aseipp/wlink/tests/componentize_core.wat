;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; A core module written against the canonical ABI names the consumer world
;; in componentize.wit implies. `wlink componentize` wraps it into a component
;; that scalar_producer then satisfies.
(module
  (import "test:math/ops" "add" (func $add (param i32 i32) (result i32)))
  (func (export "run") (result i32)
    i32.const 40
    i32.const 2
    call $add))
