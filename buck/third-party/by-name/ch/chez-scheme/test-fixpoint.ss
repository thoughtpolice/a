;; test-fixpoint.ss -- the boot files and headers from two builds are the same
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --script test-fixpoint.ss PETITE PETITE' SCHEME SCHEME' \
;;          HEADER HEADER' ...
;;
;; The boot files (the first two pairs) are compared as fasl files, which is
;; what upstream's bootstrap compares, the headers byte for byte.
(import (chezscheme))

(reset-handler (lambda () (exit 1)))

(define (pairs l)
  (if (null? l) '() (cons (cons (car l) (cadr l)) (pairs (cddr l)))))

(define (read-all path)
  (call-with-port (open-file-input-port path) get-bytevector-all))

(define failures 0)

(let ([all (pairs (command-line-arguments))])
  (for-each
   (lambda (p)
     ;; With #t, reports how they differ.
     (unless (#%$fasl-file-equal? (car p) (cdr p) #t)
       (set! failures (+ failures 1))
       (printf "FAIL: ~a and ~a differ~n" (car p) (cdr p))))
   (list-head all 2))
  (for-each
   (lambda (p)
     (unless (equal? (read-all (car p)) (read-all (cdr p)))
       (set! failures (+ failures 1))
       (printf "FAIL: ~a and ~a differ~n" (car p) (cdr p))))
   (list-tail all 2)))

(exit (if (= failures 0) 0 1))
