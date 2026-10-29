;; nqueens.ss -- N-Queens tests
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(import (chezscheme))

(include "src/ss/nqueens.ss")

(define (nqueens/test001)
  (define result (bench/nqueens (bench/hide 10 13)))
  (= 73712 result))
