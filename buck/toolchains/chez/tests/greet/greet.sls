;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (demo greet)
  (export greeting twice)
  (import (chezscheme) (demo greet name))
  (define-syntax twice (syntax-rules () [(_ e) (string-append e " " e)]))
  (define (greeting) (string-append "hello, " (name))))
