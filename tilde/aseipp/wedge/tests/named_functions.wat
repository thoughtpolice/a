;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Assembled with --debug-names, so the binary carries a name section for the
;; module, its functions, and their parameters and locals.
(module $named
  (import "host" "log" (func $log (param i32)))
  (func $accumulate (export "accumulate") (param $count i32) (result i32)
    (local $total i32)
    local.get $count
    local.set $total
    local.get $total
    call $log
    local.get $total)
  (func $helper
    i32.const 1
    call $log))
