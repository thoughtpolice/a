;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  ;; WABT groups consecutive imports from the same module into the proposal's
  ;; non-standard compact import encoding when its feature flag is enabled.
  (import "host" "first" (func))
  (import "host" "second" (func)))
