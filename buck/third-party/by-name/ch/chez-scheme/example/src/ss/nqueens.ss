;; nqueens.ss -- N-Queens benchmark.
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

;; -- N-Queens benchmark

(define trace? #f)

(define (bench/nqueens n)
  (define (iota1 n)
    (let loop ((i n) (l '()))
      (if (= i 0) l (loop (- i 1) (cons i l)))))

  (define (my-try x y z)
    (if (null? x)
      (if (null? y)
        (begin (if trace? (begin (write z) (newline))) 1)
        0)
      (+ (if (ok? (car x) 1 z)
           (my-try (append (cdr x) y) '() (cons (car x) z))
           0)
         (my-try (cdr x) (cons (car x) y) z))))

  (define (ok? row dist placed)
    (if (null? placed)
      #t
      (and (not (= (car placed) (+ row dist)))
           (not (= (car placed) (- row dist)))
           (ok? row (+ dist 1) (cdr placed)))))

  (my-try (iota1 n) '() '()))

(define (bench/nqueens-main)
  (let* ((count (read))
         (input1 (read))
         (output (read))
         (s2 (number->string count))
         (s1 (number->string input1))
         (name "nqueens"))
    (bench/run-r6rs-benchmark
     (string-append name ":" s1 ":" s2)
     count
     (lambda () (bench/nqueens (bench/hide count input1)))
     (lambda (result) (= result output)))))

;;; Given an integer and an object, returns the object
;;; without making it too easy for compilers to tell
;;; the object will be returned.
(define (bench/hide r x)
  (call-with-values
   (lambda ()
     (values (vector values (lambda (x) x))
             (if (< r 100) 0 1)))
   (lambda (v i)
     ((vector-ref v i) x))))

;; Given the name of a benchmark,
;; the number of times it should be executed,
;; a thunk that runs the benchmark once,
;; and a unary predicate that is true of the
;; correct results the thunk may return,
;; runs the benchmark for the number of specified iterations.
;;
;; Implementation-specific versions of this procedure may
;; provide timings for the benchmark proper (without startup
;; and compile time).
(define (bench/run-r6rs-benchmark name count thunk ok?)
  (printf "Running ~a... " name)
  (flush-output-port (console-output-port))
  (let loop ((i 0)
             (result (if #f #f)))
    (cond ((< i count)
           (loop (+ i 1) (thunk)))
          ((ok? result)
           result)
          (else
           (display "ERROR: returned incorrect result: ")
           (write result)
           (newline)
           result))))
