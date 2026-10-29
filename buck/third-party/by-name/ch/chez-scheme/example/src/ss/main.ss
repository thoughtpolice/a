;; main.ss -- main entry point
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

(include "src/ss/clib.ss")
(include "src/ss/nqueens.ss")
(include "src/ss/remote-cafe.ss")

;; -----------------------------------------------------------------------------
;; -- Main driver

;; -- Primary application entry point.
(define (app/main args)
  (dbg-break)

  (clib/hello)
  (printf "~a v~a (C says v~a)\n" build-time-appname build-time-version
          (clib/version))

  (let*-values ([(delta result) (timeit
                                 (lambda ()
                                   (sleep (make-time 'time-duration 0 1))))]
                [(sec)  (time-second delta)]
                [(nsec) (time-nanosecond delta)])
    (printf "ok (in ~d.~9,'0ds)\n" sec nsec))
  ;;(fork-thread-setname "test" thread/remote-cafe)
  ;;(sleep (make-time 'time-duration 0 5))
  ;;(thread/remote-cafe/die? #t)
  ;;(sleep (make-time 'time-duration 0 5))

  ;; Done.
  0)

;; -----------------------------------------------------------------------------
;; -- El fin

;; Local Variables:
;; mode: scheme
;; fill-column: 80
;; indent-tabs-mode: nil
;; c-basic-offset: 2
;; buffer-file-coding-system: utf-8-unix
;; End:
