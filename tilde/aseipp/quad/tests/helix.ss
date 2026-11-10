;; helix.ss -- Helix's keys (the key scheme 'helix)
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 60)
(set-var! 'key-scheme 'helix)
(check "Helix's keys are in use" (eq? (key-scheme-name (current-key-scheme)) 'helix))

(define (sels) (map (lambda (s) (list (sel-start s) (sel-end s))) (view-sels (current-view))))
(define (fresh! text) (headless-buffer! text 'text) (set-sels! (current-buffer) (list (make-sel 0 1))))

;; Words are selected, from the cursor to the next.
(fresh! "hello world foo\nsecond line\n")
(press! "w")
(expect-equal "w" (primary-text) "hello ")
(press! "w")
(expect-equal "w again" (primary-text) "world ")
(press! "e")
(expect-equal "e" (primary-text) "foo")
(press! "b")
(expect-equal "b" (primary-text) "foo")
(press! "l")
(expect-equal "l moves a cursor" (sels) '((13 14)))

;; Lines, everything, and what to do with them.
(press! "x")
(expect-equal "x" (primary-text) "hello world foo\n")
(press! "x")
(expect-equal "x again" (primary-text) "hello world foo\nsecond line\n")
(press! "%")
(expect-equal "%" (sels) '((0 28)))
(fresh! "one two three")
(press! "w" "d")
(expect-equal "d" (buffer-contents) "two three")
(press! "e" "c")
(type! "2")
(press! "esc")
(expect-equal "c" (buffer-contents) "2 three")
(press! "x" "y")
(expect-equal "y" (clipboard-top) '("2 three"))

;; s: the matches of a pattern in the selection, a selection each.
(fresh! "a1 b22 c333")
(press! "%" "s")
(type! "[0-9]+")
(press! "enter")
(expect-equal "s" (map (lambda (s) (apply substring (buffer-contents) s)) (sels)) '("1" "22" "333"))
(press! ",")
(expect-equal ", keeps the primary" (length (sels)) 1)

;; Select mode extends.
(fresh! "alpha beta gamma")
(press! "v" "l" "l" "l")
(expect-equal "v l l l" (primary-text) "alph")
(press! "esc")

;; Goto, and match.
(fresh! "f(x, (y))\nlast")
(press! "g" "e")
(expect-equal "ge" (sels) '((10 11)))
(press! "g" "g" "l" "m" "i" "(")
(expect-equal "mi(" (primary-text) "x, (y)")
(press! "m" "a" "(")
(expect-equal "ma(" (primary-text) "(x, (y))")

;; w stops at its line's end, and the next w starts on the next line.
(fresh! "wrap me\nnext\n")
(press! "w" "w")
(expect-equal "w at a line's end" (primary-text) "me")
(press! "w")
(expect-equal "and on to the next" (primary-text) "next")

;; N after n goes back to the match before, not the one selected.
(fresh! "x needle x needle x")
(press! "/")
(type! "needle")
(press! "enter" "n" "N")
(expect-equal "n N" (sels) '((2 8)))

;; Registers: "x before y, d, p and R; the unnamed one has the last yank.
(fresh! "one two")
(press! "w" "\"" "k" "y" "w" "y" "x" "\"" "k" "R")
(expect-equal "\"ky then \"kR" (buffer-contents) "one ")
(fresh! "ab")
(press! "\"" "k" "y" "l" "y" "\"" "k" "p" "p")
(expect-equal "\"kp, then p the unnamed" (buffer-contents) "abab")

;; Macros: Q records until Q, q plays (into "x, in @ otherwise).
(fresh! "a\nb\nc\n")
(press! "Q" "A")
(type! "!")
(press! "esc" "j" "Q" "q" "\"" "m" "Q" "j" "Q")
(expect-equal "Q ... Q, q" (buffer-contents) "a!\nb!\nc\n")
(press! "q")
(expect-equal "q again" (buffer-contents) "a!\nb!\nc!\n")

;; Back to Ki's keys.
(set-var! 'key-scheme 'ki)
