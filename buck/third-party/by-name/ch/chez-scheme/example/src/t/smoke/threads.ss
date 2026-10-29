;; threads.ss -- native thread tests
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

(include "src/ss/remote-cafe.ss")

;; Solve the board in several named threads at once and join them all.
(define (threads/test001)
  (when-threaded
   (let* ([n 4]
          [results (make-vector n #f)]
          [threads
           (map (lambda (i)
                  (fork-thread-setname
                   (format "nqueens-~d" i)
                   (lambda ()
                     (vector-set! results i (bench/nqueens 8)))))
                (iota n))])
     (for-each thread-join threads)
     (for-all (lambda (r) (eqv? r 92)) (vector->list results)))))

;; The cafe thread the application's main once started: it wakes every couple
;; of seconds until the parameter, which all threads share, tells it to stop.
(define (threads/test002)
  (when-threaded
   (let ([t (fork-thread-setname "remote-cafe" thread/remote-cafe)])
     (thread/remote-cafe/die? #t)
     (thread-join t)
     #t)))
