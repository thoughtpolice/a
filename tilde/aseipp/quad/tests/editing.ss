;; editing.ss -- actions: insert, change, delete, cut, copy, paste, swap...
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The fake terminal speaks the legacy protocol, so a momentary layer's
;; default is its key pressed twice ("r" "r").

(headless-start! 24 80)

;; Delete one word, with the gap after it.
(headless-buffer! "one two three" 'text)
(press! "s" "r" "r")
(expect-equal "delete word" (buffer-contents) "two three")
(expect-equal "delete selects next" (primary-text) "two")
(press! "z" "z")
(expect-equal "undo" (buffer-contents) "one two three")
(press! "Z")
(expect-equal "redo" (buffer-contents) "two three")

;; Delete leftwards takes the gap before.
(headless-buffer! "one two three" 'text)
(press! "s" "p" "r" "j")
(expect-equal "delete left" (buffer-contents) "one two")
(expect-equal "delete left selects previous" (primary-text) "two")

;; Lines delete whole.
(headless-buffer! "a\nb\nc\n" 'text)
(press! "a" "l" "r" "r")
(expect-equal "delete line" (buffer-contents) "a\nc\n")

;; Insert before and after, as one undo step.
(headless-buffer! "world" 'text)
(press! "s" "h")
(type! "hello ")
(press! "esc")
(expect-equal "insert" (buffer-contents) "hello world")
(press! "s" "p" ";")
(type! "!")
(press! "esc")
(expect-equal "append" (buffer-contents) "hello world!")
(press! "z" "z")
(expect-equal "undo insert session" (buffer-contents) "hello world")

;; Change: g twice replaces the selection.
(headless-buffer! "red fish" 'text)
(press! "s" "g" "g")
(type! "blue")
(press! "esc")
(expect-equal "change" (buffer-contents) "blue fish")

;; Copy and paste with gaps: c c copies; v l pastes after, with the gap.
(headless-buffer! "(a b)" 'scheme)
(press! "s" "l" "c" "c" "v" "l")
(expect-equal "gap paste" (buffer-contents) "(a a b)")
;; v v replaces.
(press! "l" "v" "v")
(expect-equal "replace" (buffer-contents) "(a a a)")

;; Cut and paste a line below.
(headless-buffer! "first\nsecond\n" 'text)
(press! "a" "x" "x")
(expect-equal "cut line" (buffer-contents) "second\n")
(press! "v" "k")
(expect-equal "paste below" (buffer-contents) "second\nfirst\n")

;; Duplicate a node after itself.
(headless-buffer! "(x)" 'scheme)
(press! "d" "c" "l")
(expect-equal "duplicate" (buffer-contents) "(x) (x)")

;; Swap nodes: t then a movement.
(headless-buffer! "(f a b)" 'scheme)
(press! "d" "k" "l" "t" "l")
(expect-equal "swap" (buffer-contents) "(f b a)")
(expect-equal "swap keeps the moved text selected" (primary-text) "a")

;; Open a line below, indented like Scheme wants.
(headless-buffer! "(define (f x)\n  x)" 'scheme)
(press! "a" "g" "k")
(type! "y")
(press! "esc")
(expect-equal "open below indents" (buffer-contents) "(define (f x)\n  y\n  x)")

;; Newline in insert mode aligns under the second element of a call.
(headless-buffer! "(foo bar)" 'scheme)
(press! "s" "l" "l" ";" "enter")
(type! "baz")
(press! "esc")
(expect-equal "lisp indent" (buffer-contents) "(foo bar\n     baz)")

;; Auto-pairs.
(headless-buffer! "" 'scheme)
(press! "h")
(type! "(let [x")
(press! "esc")
(expect-equal "auto pairs" (buffer-contents) "(let [x])")

;; Multiple cursors: b l adds one at the next unit; typing goes to both.
(headless-buffer! "a a a" 'text)
(press! "s" "b" "l")
(expect-equal "two cursors" (length (view-sels (current-view))) 2)
(press! "g" "g")
(type! "b")
(press! "esc")
(expect-equal "multi-cursor change" (buffer-contents) "b b a")
;; All occurrences.
(headless-buffer! "x y x y x" 'text)
(press! "s" "n" "n")
(expect-equal "all occurrences" (length (view-sels (current-view))) 3)
(press! "r" "r")
(expect-equal "delete all occurrences" (buffer-contents) "y y")

;; Join and break.
(headless-buffer! "a\n   b" 'text)
(press! "I")
(expect-equal "join" (buffer-contents) "a b")
(press! "s" "l" "K")
(expect-equal "break" (buffer-contents) "a\nb")

;; Indent and dedent.
(headless-buffer! "x\ny" 'text)
(press! "f" "f" "L")
(expect-equal "indent" (buffer-contents) "  x\n  y")
(press! "J")
(expect-equal "dedent" (buffer-contents) "x\ny")

;; Transforms.
(headless-buffer! "fooBarBaz" 'text)
(press! "s" "F" "s")
(expect-equal "snake" (buffer-contents) "foo_bar_baz")
(press! "F" "e")
(expect-equal "pascal" (buffer-contents) "FooBarBaz")

;; Surround: , s m wraps in parens; , r m unwraps.
(headless-buffer! "x" 'scheme)
(press! "s" "," "s" "m")
(expect-equal "surround" (buffer-contents) "(x)")
(press! "," "r" "m")
(expect-equal "delete surround" (buffer-contents) "x")

;; Comments toggle.
(headless-buffer! "(a)\n(b)" 'scheme)
(press! "f" "f" "F" "k")
(expect-equal "comment" (buffer-contents) ";; (a)\n;; (b)")
(press! "F" "k")
(expect-equal "uncomment" (buffer-contents) "(a)\n(b)")

;; Clipboard history: v y steps to the older entry.
(headless-buffer! "one two" 'text)
(press! "s" "c" "c" "l" "c" "c" "v" "y")
(expect-equal "replace history" (buffer-contents) "one one")

;; Bracketed paste: in normal mode it replaces the selection.
(headless-buffer! "old" 'text)
(press! "s" (make-paste-event "new"))
(expect-equal "bracketed paste" (buffer-contents) "new")

;; Saving writes the file atomically.
(let ([path (path-join (test-temp-dir "editing") "save.txt")])
  (call-with-output-file path (lambda (p) (display "abc" p)))
  (switch-to-buffer! (open-file! path))
  (press! "s" "g" "g")
  (type! "xyz")
  (press! "esc" "enter")
  (expect-equal "saved" (read-file-string path) "xyz")
  (check "not modified after save" (not (buffer-modified? (current-buffer)))))

;; Evaluating Scheme: eval-string runs in the quad environment.
(expect-equal "eval" (eval-string "(+ 1 2)") 3)
(headless-buffer! "(* 6 7)" 'scheme)
(press! "d" "space" "l" "e")
(expect-equal "eval selection" (cdr (current-message)) "⇒ 42")

;; Extensions register as the editor boots: the BLAKE3 command, built on the
;; kernel's Rust half, is bound and hashes the selection.
(headless-buffer! "abc" 'text)
(press! "s" "space" "l" "h")
(expect-equal "hash-selection" (cdr (current-message))
              "BLAKE3 6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85")
