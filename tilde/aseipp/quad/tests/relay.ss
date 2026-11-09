;; relay.ss -- a client of this editor showing another one, and coming back
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run by :test-remote, with a daemon at $QUAD_SOCKET showing a file that
;; says "remote content".

;; Run the event loop until (pred); a timeout ends the test.
(define (run-until name pred)
  (let* ([deadline (+ (real-time) 10000)] [timed-out? #f]
         [src (make-source -1 void (lambda () (max 0 (- deadline (real-time))))
                           (lambda () (set! timed-out? #t) (editor-stop!))
                           (lambda () (when (pred) (editor-stop!))))])
    (add-source! src)
    (unless (pred) (server-run!))
    (remove-source! src)
    (when timed-out? (printf "FAIL ~a: timed out\n" name) (exit 1))
    (editor-restart!)
    (redraw!)))

(define (on-screen? s) (exists (lambda (r) (string-contains r s)) (screen)))

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
