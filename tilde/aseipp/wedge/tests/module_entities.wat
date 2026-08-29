;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $callback (func (param i32) (result i32)))
  (import "host" "callback" (func $callback (type $callback)))
  (import "host" "table" (table $table 1 funcref))
  (import "host" "memory" (memory $memory 1))
  (import "host" "global" (global $global i32))
  (import "host" "tag" (tag $tag (param i32)))

  (export "callback" (func $callback))
  (export "table" (table $table))
  (export "memory" (memory $memory))
  (export "global" (global $global))
  (export "tag" (tag $tag))

  ;; Custom annotations are the standardized text representation of opaque
  ;; custom binary sections.
  (@custom "wedge.meta" "dataflow"))
