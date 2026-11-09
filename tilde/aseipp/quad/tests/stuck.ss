;; stuck.ss -- a client that stops reading does not stop the daemon
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run by BUILD's test-remote against a daemon at $QUAD_SOCKET: one client
;; attaches with a big screen and never reads, as one stopped with ^Z does,
;; while another edits what it shows, so that the daemon draws for it far
;; more than its socket holds. The daemon must go on answering.

(define stuck (kernel-unix-connect (getenv "QUAD_SOCKET")))
((frame-sender stuck) (list "hello" protocol-version "stuck" 200 400 '()))

(define fd (kernel-unix-connect (getenv "QUAD_SOCKET")))
(define send (frame-sender fd))
(define reader (make-frame-reader))
(send (list "hello" protocol-version "editing" 3 10 '()))

;; Evaluate expr in the daemon; its result, or #f if none came in time.
(define (eval-there! id expr)
  (send (list "eval" id expr))
  (let loop ()
    (let* ([got (kernel-read-some fd 5000)]
           [r (and got (> (bytevector-length got) 0)
                   (find (lambda (m) (and (equal? (car m) "result") (eqv? (cadr m) id)))
                         (reader got (bytevector-length got))))])
      (cond
       [r (cadddr r)]
       [(and got (> (bytevector-length got) 0)) (loop)]
       [else #f]))))

;; Each edit changes the whole of what the stuck client shows.
(define lines (apply string-append (make-list 300 (string-append (make-string 300 #\x) "\n"))))
(check "the daemon answers while a client is stuck"
       (let loop ([i 1])
         (or (> i 40)
             (and (eval-there! i (if (odd? i)
                                     (format "(begin (buffer-insert! (current-buffer) 0 ~s) 1)" lines)
                                     (format "(begin (buffer-delete! (current-buffer) 0 ~a) 1)" (string-length lines))))
                  (loop (+ i 1))))))
(send '("detach"))
(kernel-close fd)
(kernel-close stuck)
