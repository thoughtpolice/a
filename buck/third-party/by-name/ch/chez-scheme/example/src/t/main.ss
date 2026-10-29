;; main.ss -- test framework entry point
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))
(include "src/t/smoke/nqueens.ss")
(include "src/t/smoke/clib.ss")
(include "src/t/smoke/threads.ss")

;; -----------------------------------------------------------------------------
;; -- Utilities

(define (test-ok? b) (if b "ok" "fail"))

;; Same as 'timeit', but return timing report in milliseconds
(define (timeit/test action)
  (let*-values ([(delta r) (timeit action)]
                [(sec)  (time-second delta)]
                [(nsec) (time-nanosecond delta)]
                [(msec) (+ (* sec 1000) (div nsec 1000000))])
    (values msec r)))

;; -----------------------------------------------------------------------------
;; -- Gold tests

(define (test/gold port)
  (define tests (directory-list "src/t/gold"))

  (define (get-string-all p)
    (let loop ([acc ""] [str (get-string-some p)])
      (if (eof-object? str)
          acc
          (loop (string-append acc str) (get-string-some p)))))

  (fold-left
   (lambda (acc test)
     (define r 0)
     (define s #f)
     (define (run-test)
       (define tr
         (process (string-append "unset SCHEMEHEAPDIRS; exec "
                                 (string-append "src/t/gold/" test)
                                 " 2>&1")))
       (set! s (list-ref tr 0))    ;; get textual stdout port
       (set! r (list-ref tr 2))    ;; get pid
       (set! s (get-string-all s)) ;; get stdout
       (set! r (waitpid-return r)) ;; get exit code
       s)

     (let*-values ([(msec out) (timeit/test run-test)]
                   [(ok)   (test-ok? (equal? r 0))])
       (fprintf port "gold ~a ~a ~a ~s\n" test ok msec out)
       (if (equal? 0 r) acc 1)))
   0
   (sort string<? tests)))

;; -----------------------------------------------------------------------------
;; -- API tests

(define smoke-tests
  `(("nqueens/test001" . ,nqueens/test001)
    ("clib/test001"    . ,clib/test001)
    ("clib/test002"    . ,clib/test002)
    ("threads/test001" . ,threads/test001)
    ("threads/test002" . ,threads/test002)))

(define (test/smoke port)
  (fold-left
   (lambda (acc test)
     (let*-values ([(msec r) (timeit/test (cdr test))]
                   [(ok)     (test-ok? r)])
       (fprintf port "smoke ~a ~a ~a \"\"\n" (car test) ok msec)
       (if r acc 1)))
   0
   smoke-tests))

;; -----------------------------------------------------------------------------
;; -- Main driver

;; -- Test driver entry point.
(define (app/main args)
  (define report-file "build/test.report")

  (if (file-exists? report-file)
      (delete-file report-file))

  (call-with-output-file report-file
    (lambda (p)
      (define gr (test/gold p))
      (define sr (test/smoke p))
      (if (= 0 gr sr)
          0 ;; success
          1 ;; failure
          ))))

;; -----------------------------------------------------------------------------
;; -- El fin

;; Local Variables:
;; mode: scheme
;; fill-column: 80
;; indent-tabs-mode: nil
;; c-basic-offset: 2
;; buffer-file-coding-system: utf-8-unix
;; End:
