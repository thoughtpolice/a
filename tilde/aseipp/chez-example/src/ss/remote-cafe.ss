;; remote-cafe.ss -- a long-running background thread
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(import (chezscheme))

;; -----------------------------------------------------------------------------
;; -- Cafe thread

(define thread/remote-cafe/die?
  (make-parameter
   #f
   (lambda (x)
     (unless (boolean? x)
             (assertion-violationf
              'thread/remote-cafe/die?
              "~s is not a bool or #f"
              x))
     x)))

(define (thread/remote-cafe)
  (printf "thread\n")
  (if (thread/remote-cafe/die?)
      (printf "die\n")
      (begin
        (sleep (make-time 'time-duration 0 2))
        (thread/remote-cafe))))
