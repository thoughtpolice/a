;; connect.ss -- showing another editor over iroh, without waiting for it
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run by BUILD's test-mesh with a daemon's ticket in $QUAD_TICKET: a
;; client of this editor switches to the daemon over iroh while this
;; editor goes on; and this editor refuses to show itself, by its own
;; ticket or by its own socket however spelled.

(headless-start! 12 60)
(define c (current-client))
(define failures '())
(define (failed why) (set! failures (cons why failures)))

;; Connecting returns at once; the editor goes on until it is done.
(relay-connect-later! c (getenv "QUAD_TICKET") failed)
(check "not yet" (not (relayed? c)))
(run-until "connected over iroh" (lambda () (relayed? c)))
(check "nothing failed" (null? failures))
(relay-end! c #f)

;; A client that leaves while connecting gives up on it.
(define d (headless-client! 12 60))
(relay-connect-later! d (getenv "QUAD_TICKET") failed)
(remove-client! d)
(let ([until (+ (real-time) 1000)]) (run-until "a while" (lambda () (> (real-time) until))))
(check "the client that left shows nothing" (not (relayed? d)))

;; This editor, by its own ticket.
(mesh-listen! #f)
(run-until "a ticket of its own" (lambda () (cdr (assq 'ticket (mesh-info)))))
(relay-connect-later! c (cdr (assq 'ticket (mesh-info))) failed)
(run-until "refused" (lambda () (pair? failures)))
(check "its own ticket is this editor" (string-contains (car failures) "is this editor"))
(check "and it shows this one still" (not (relayed? c)))

;; This editor, by its own socket, spelled another way.
(let* ([dir (test-temp-dir "connect")] [path (path-join dir "own.sock")])
  (server-listen! path)
  (check "its own socket, spelled otherwise, is this editor"
         (guard (e [#t (string-contains (condition->string e) "is this editor")])
           (relay-connect! c (string-append dir "/./own.sock"))
           #f))
  (server-unlisten! path))
