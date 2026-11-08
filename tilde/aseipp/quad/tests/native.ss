;; native.ss -- components in Rust: (quad native), from kernel/lib.rs
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define (error-of thunk) (guard (e [#t (condition-message e)]) (thunk) "no error"))

(expect-equal "blake3" (blake3-hex "abc") "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85")
(expect-equal "blake3 of a bytevector" (bytevector-length (blake3 (bytevector 1 2 3))) 32)
(expect-equal "types are checked" (error-of (lambda () (blake3 42)))
              "argument 1 (data): expected a bytevector, got 42")
(check "arity is checked" (string? (error-of (lambda () (blake3)))))

;; A ticker: a Rust thread, delivering through a mailbox whose descriptor
;; the editor's event loop watches like any other.
(headless-start! 10 40)
(define t (make-ticker 5 3))
(check "a Rust object" (native-object? t))
(define ticks '())
(define src
  (watch-fd! (ticker-fd t)
             (lambda ()
               (set! ticks (append ticks (ticker-take! t)))
               (when (= (length ticks) 3) (editor-stop!)))))
(server-run!)
(remove-source! src)
(editor-restart!)
(expect-equal "ticks through the event loop" ticks '(1 2 3))

;; Objects are typed, and dropped once and for all.
(check "wrong object" (string-contains (error-of (lambda () (ticker-fd (cons 'x 1)))) "Ticker object"))
(native-drop! t)
(check "dropped" (string-contains (error-of (lambda () (ticker-fd t))) "dropped"))
