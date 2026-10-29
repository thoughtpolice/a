;; nqueens.ss -- N-Queens tests
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

(include "src/ss/nqueens.ss")

(define (nqueens/test001)
  (define result (bench/nqueens (bench/hide 10 13)))
  (= 73712 result))
