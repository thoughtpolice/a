;; relay.ss -- a client of this editor showing another one, and coming back
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run by :test-remote, with a daemon at $QUAD_SOCKET showing a file that
;; says "remote content".



(headless-start! 12 60)
(define here (headless-buffer! "local text\n" 'text))
(define c (current-client))
(check "this editor, first" (on-screen? "local text"))

;; Switch to the daemon: its frames are painted here.
(relay-connect! c #f)
(check "showing another editor" (relayed? c))
(run-until "the daemon's frame" (lambda () (on-screen? "remote content")))
(check "its frame, not this one's" (not (on-screen? "local text")))

;; This editor goes on running meanwhile, and draws nothing over it.
(buffer-insert! here 0 "more ")
(redraw!)
(check "this editor's frames are not painted over it" (not (on-screen? "more local text")))

;; Keys go to the daemon: leaving it (space j v) comes back here.
(press! "space" "j" "v")
(run-until "back" (lambda () (not (relayed? c))))
(check "this editor again" (on-screen? "more local text"))
(check "and it says so" (on-screen? "Back in this editor"))

;; Not this editor, nor nothing.
(check "nowhere is an error"
       (guard (e [#t #t]) (relay-connect! c "/nonexistent/quad.sock") #f))
(check "still here" (not (relayed? c)))

;; A client that closes while it shows the daemon leaves the daemon too.
(define (daemon-clients)
  (let* ([fd (kernel-unix-connect (getenv "QUAD_SOCKET"))]
         [send (frame-sender fd)]
         [reader (make-frame-reader)])
    (send (list "hello" protocol-version "eval" 3 10 '()))
    (send (list "eval" 1 "(length (clients))"))
    (let loop ()
      (let* ([got (kernel-read-some fd 5000)]
             [r (and got (find (lambda (m) (equal? (car m) "result")) (reader got (bytevector-length got))))])
        (cond
         [r (send '("detach")) (kernel-close fd) (string->number (cadddr r))]
         [got (loop)]
         [else (kernel-close fd) #f])))))
(define (wait! ms) (sleep (make-time 'time-duration (* ms 1000000) 0)))
(define d (headless-client! 12 60))
(define before (daemon-clients))
(relay-connect! d #f)
(run-until "the second client shows the daemon" (lambda () (relayed? d)))
(expect-equal "the daemon has it" (daemon-clients) (+ before 1))
(remove-client! d)
(expect-equal "and lets it go"
              (let loop ([n 0])
                (let ([k (daemon-clients)])
                  (if (or (= k before) (= n 20)) k (begin (wait! 100) (loop (+ n 1))))))
              before)
