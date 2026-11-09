;; lost.ss -- a client over iroh learns soon that its editor is gone
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run by BUILD's test-mesh, with the editor's ticket in $QUAD_TICKET: this
;; attaches, says so on standard output, and waits for the connection to
;; end, which must be within $QUAD_LOST_WITHIN milliseconds of the editor
;; going (BUILD kills it once this has attached).

(define-values (fd session editor) (mesh-connect-fd! (getenv "QUAD_TICKET")))
(define send (frame-sender fd))
(send (list "hello" protocol-version "lost-test" 24 80 '()))
(display "attached\n")
(flush-output-port)

(define within (string->number (getenv "QUAD_LOST_WITHIN")))
;; The editor is killed some time after this, so the wait is measured from
;; the last message it sent (it draws once, on attaching).
(let loop ([heard (real-time)])
  (let ([got (kernel-read-some fd 200)])
    (cond
     [(not got)
      (check "the editor's going is noticed in time" (<= (- (real-time) heard) within))]
     [(> (- (real-time) heard) (+ within 30000)) (check "the connection ended" #f)]
     [else (loop (if (> (bytevector-length got) 0) (real-time) heard))])))
