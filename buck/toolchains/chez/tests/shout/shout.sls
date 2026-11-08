;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (demo shout)
  (export shout)
  (import (chezscheme) (demo greet))
  ;; Uses (demo greet)'s macro, from its compiled object alone.
  (define (shout) (string-upcase (twice (greeting)))))
