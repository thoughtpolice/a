;; loop.ss -- the event loop draws clients only after something may have
;; changed what they show
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 40)
(define buf (headless-buffer! "some text, and https://example.com/x\n" 'text))

(define path (let ([t (current-time)]) (format "/tmp/quad-loop-test-~a-~a.sock" (time-second t) (time-nanosecond t))))
(server-listen! path)

;; A client over the socket, whose messages the loop reads.
(define fd (kernel-unix-connect path))
(define send (frame-sender fd))
(send (list "hello" protocol-version "test" 12 40 '("pointer-shape")))

(define renders 0)
(add-hook! 'before-render-hook (lambda (c) (set! renders (+ renders 1))))

;; Run the loop until (pred), which its sources' ticks ask after each
;; round.
(define (run-until name pred)
  (let* ([deadline (+ (real-time) 10000)] [timed-out? #f]
         [src (make-source -1 void (lambda () (max 0 (- deadline (real-time))))
                           (lambda () (set! timed-out? #t) (editor-stop!))
                           (lambda () (when (pred) (editor-stop!))))])
    (add-source! src)
    (server-run!)
    (remove-source! src)
    (editor-restart!)
    (when timed-out? (printf "FAIL ~a: timed out\n" name) (exit 1))))

(define (remote) (find (lambda (c) (equal? (client-name c) "test")) (clients)))
(run-until "the client connects" remote)
(with-client (remote) (lambda () (switch-to-buffer! buf)))

(define (move! col mods) (send (list "mouse" "move" 0 col 1 mods)))
(define (pointer) (client-local (remote) 'pointer #f))

(move! 8 0)
(run-until "a move" (lambda () (equal? (pointer) "text")))
;; Over the same text, moves change nothing: no round draws.
(define before renders)
(move! 9 0) (move! 10 0)
(run-until "more moves" (lambda () #t))
(move! 11 0)
(run-until "and more" (lambda () #t))
(expect-equal "moves over the same things draw nothing" renders before)

;; With ctrl, over a link: it is underlined, so the next round draws.
(move! 22 mod-ctrl)
(run-until "over a link" (lambda () (equal? (pointer) "pointer")))
(move! 23 mod-ctrl)
(run-until "along it" (lambda () #t))
(expect-equal "a move that underlines a link draws" (> renders before) #t)

;; A key changes things: the round after it draws.
(define before-key renders)
(send (list "key" "l" 0 "l" "press"))
(run-until "a key" (lambda () #t))
(move! 23 mod-ctrl)
(run-until "then a move" (lambda () #t))
(expect-equal "a key draws" (> renders before-key) #t)

(kernel-close fd)
(server-unlisten! path)
