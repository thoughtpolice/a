;; selection.ss -- selection modes and movements, driven by keys
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 24 80)

;; Words: s selects, l/j move over words, skipping symbols; o/u include them.
(headless-buffer! "foo.bar(baz, quuxFoo) last\n\nnext line" 'text)
(press! "s")
(expect-equal "word" (primary-text) "foo")
(press! "l")
(expect-equal "word right" (primary-text) "bar")
(press! "o")
(expect-equal "word next includes symbols" (primary-text) "(")
(press! "l" "l")
(expect-equal "word right x2" (primary-text) "quuxFoo")
(press! "w")
(expect-equal "subword" (primary-text) "quux")
(press! "l")
(expect-equal "subword right" (primary-text) "Foo")
(press! "W")
(expect-equal "char" (primary-text) "F")
(press! "s" "p")
(expect-equal "word last on line" (primary-text) "last")
(press! "y")
(expect-equal "word first on line" (primary-text) "foo")
(press! "k")
(expect-equal "word down skips blank lines" (primary-text) "next")

;; Lines: a selects without indentation; o goes to the next blank line.
(headless-buffer! "  one\n  two\n\nthree" 'text)
(press! "a")
(expect-equal "line" (primary-text) "one")
(press! "l")
(expect-equal "line down" (primary-text) "two")
(press! "o")
(expect-equal "line next blank" (primary-text) "")
(press! "p")
(expect-equal "line last" (primary-text) "three")
(press! "A")
(expect-equal "full line" (primary-text) "three")
(press! "y")
(expect-equal "full line first" (primary-text) "  one\n")

;; Nodes: s-expressions in Scheme.
(headless-buffer! "(define (f x) (+ x 1))\n(g 'y)" 'scheme)
(press! "d")
(expect-equal "node" (primary-text) "(define (f x) (+ x 1))")
(press! "k")
(expect-equal "node down: first child" (primary-text) "define")
(press! "l")
(expect-equal "node right: sibling" (primary-text) "(f x)")
(press! "l")
(expect-equal "node right again" (primary-text) "(+ x 1)")
(press! "i")
(expect-equal "node up: parent" (primary-text) "(define (f x) (+ x 1))")
(press! "l" "k" "l")
(expect-equal "quoted node" (primary-text) "'y")
(press! "i" "j" "o")
(expect-equal "node next: preorder" (primary-text) "define")

;; Paragraphs.
(headless-buffer! "a\nb\n\nc\nd\n" 'text)
(press! "E")
(expect-equal "paragraph" (primary-text) "a\nb")
(press! "l")
(expect-equal "next paragraph" (primary-text) "c\nd")

;; Search: n d opens the prompt; then l and j step through matches.
(headless-buffer! "cat dog cat bird cat" 'text)
(press! "n" "d")
(type! "cat")
(press! "enter")
(expect-equal "search" (primary-text) "cat")
(press! "l")
(expect-equal "search next" (sel-start (car (view-sels (current-view)))) 8)
(press! "l" "l")
(expect-equal "search wraps" (sel-start (car (view-sels (current-view)))) 0)

;; Extend: f, then movements grow the selection.
(headless-buffer! "one two three four" 'text)
(press! "s" "f" "l" "l")
(expect-equal "extend" (primary-text) "one two three")
(press! "esc" "r" "r")
(expect-equal "delete extended" (buffer-contents) "four")

;; Jump: m labels the visible units; typing a label selects it.
(headless-buffer! "alpha beta gamma" 'text)
(press! "s" "m")
(check "jump labels shown" (= 3 (length (jump-labels))))
(press! (car (list-ref (jump-labels) 2)))
(expect-equal "jump" (primary-text) "gamma")

;; Selection history: backspace goes back, tab forward.
(headless-buffer! "a b c" 'text)
(press! "s" "l" "l")
(press! "backspace")
(expect-equal "history back" (primary-text) "b")
(press! "tab")
(expect-equal "history forward" (primary-text) "c")
