;; clib.ss -- C library function bindings
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

;; -----------------------------------------------------------------------------
;; -- C glue

;; Bindings to C function pointers, which we use to wrap and give names to
;; foreign procedures.
(define clib/hello)
(define clib/version)

;; Initialization of app-specific C functions. Loading/unloading isn't handled
;; here since it's not directly application specific. Note that this function
;; is run far earlier than application/main, and should only be used to
;; initialize any foreign library code. That includes both external libraries
;; (e.g. libtls or somesuch) and functions from your internal C code.
(define (app/initialize/c)
  ;; C functions
  (set! clib/hello   (foreign-procedure "c_hello" () void))
  (set! clib/version (foreign-procedure "c_version" () string)))

;; -----------------------------------------------------------------------------
;; -- El fin

;; Local Variables:
;; mode: scheme
;; fill-column: 80
;; indent-tabs-mode: nil
;; c-basic-offset: 2
;; buffer-file-coding-system: utf-8-unix
;; End:
