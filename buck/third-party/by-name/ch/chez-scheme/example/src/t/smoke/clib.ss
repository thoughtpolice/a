;; clib.ss -- C library tests
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

(include "src/ss/clib.ss")

;; The companion library is loaded with load-shared-object at startup; its
;; version string has to agree with the one compiled into the Scheme code.
(define (clib/test001)
  (clib/hello)
  (equal? (clib/version) build-time-version))

;; The C kernel's own primitives, registered with Sforeign_symbol rather than
;; found in a shared object.
(define (clib/test002)
  (and (> (get-num-cores) 0)
       (memv (thread-set-affinity -1) '(-2 -3))
       #t))
