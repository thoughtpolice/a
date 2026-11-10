;; tutor-helix.ss -- the Helix tutor's exercises, done with the keys its
;; lessons give
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; As tutor.ss does Ki's: each exercise is a few indented lines, then what
;; they should become, as "  ✓ " lines.

(headless-start! 30 100)
(set-var! 'key-scheme 'helix)
(press! "space" "k" "h")
(check "the Helix tutor" (and (equal? (buffer-name (current-buffer)) "*tutor*")
                            (equal? (buffer-contents) helix-tutor-text)
                            (string-contains helix-tutor-text "with Helix's keys")))

(define (block lines) (apply string-append (map (lambda (l) (string-append "\n    " l)) lines)))

;; Put the cursor on lines' line number line (of them), column column,
;; press keys (a list (t "text") types text), and compare with result.
(define (exercise name lines keys result line column)
  (for-each (lambda (r)
              (check (format "~a: the tutor shows ~s" name r)
                     (string-contains helix-tutor-text (string-append "\n  ✓ " r "\n"))))
            result)
  (let ([i (string-contains (buffer-contents) (string-append (block lines) "\n"))])
    (if (not i)
        (begin (failure!) (printf "FAIL ~a: the tutor has no such lines\n" name))
        (let ([at (let loop ([pos (+ i 1)] [n line])
                    (if (= n 0) pos (loop (+ (string-index (buffer-contents) #\newline pos) 1) (- n 1))))])
          (set-primary! (make-sel (+ at 4 column) (+ at 5 column)))
          (for-each (lambda (k) (if (string? k) (press! k) (type! (cadr k)))) keys)
          (check name (string-contains (buffer-contents) (string-append (block result) "\n")))
          (press! "esc" "esc")))))

;; Lesson 2
(exercise "w d" '("The cat cat sat on the mat.") '("w" "w" "w" "d") '("The cat sat on the mat.") 0 0)
(exercise "x d" '("Keep this line." "Delete this line." "Keep this line too.")
          '("x" "d") '("Keep this line." "Keep this line too.") 1 0)
(press! "u")
(check "u" (string-contains (buffer-contents) (block '("Keep this line." "Delete this line." "Keep this line too."))))
(press! "U")
(check "U" (not (string-contains (buffer-contents) (block '("Keep this line." "Delete this line.")))))

;; Lesson 3
(exercise "i" '("quad is editor.") '("w" "w" "w" "i" (t "an ") "esc") '("quad is an editor.") 0 0)
(exercise "A" '("Hello, world") '("A" (t "!") "esc") '("Hello, world!") 0 0)
(exercise "o" '("first" "third") '("o" (t "second") "esc") '("first" "second" "third") 0 0)

;; Lesson 4
(exercise "c" '("The sky is green.") '("w" "w" "w" "w" "c" (t "blue") "esc") '("The sky is blue.") 0 0)
(exercise "alt+`" '("make this loud") '("w" "w" "w" "alt+`") '("make this LOUD") 0 0)

;; Lesson 5
(exercise "y w P" '("one two three") '("w" "y" "w" "P") '("one one two three") 0 0)
(exercise "x d x p" '("2. second" "1. first" "3. third") '("x" "d" "x" "p") '("1. first" "2. second" "3. third") 0 0)
(exercise "registers" '("keep me" "drop me")
          '("x" "\"" "k" "y" "j" "x" "d" "k" "x" "\"" "k" "p") '("keep me" "keep me") 0 0)

;; Lesson 6
(exercise "s" '("cat dog cat bird cat") '("x" "s" (t "cat") "enter" "c" (t "cow") "esc" ",")
          '("cow dog cow bird cow") 0 0)
(check "one selection again" (= (length (view-sels (current-view))) 1))
(exercise "C" '("a = 1" "b = 2" "c = 3") '("C" "C" "i" (t "let ") "esc" ",") '("let a = 1" "let b = 2" "let c = 3") 0 0)
(exercise "v" '("one two three four") '("v" "w" "w" "d") '("three four") 0 0)

;; Lesson 7: search, then the next match and back.
(define haystack "hay hay hay needle hay hay hay hay needle hay")
(let* ([i (string-contains (buffer-contents) (block (list haystack)))]
       [first (+ i 5 (string-contains haystack "needle"))])
  (set-primary! (make-sel (+ i 5) (+ i 6)))
  (press! "/")
  (type! "needle")
  (press! "enter")
  (check "found" (= (sel-start (view-primary (current-view))) first))
  (press! "n")
  (check "the next" (> (sel-start (view-primary (current-view))) first))
  (press! "N")
  (check "and back" (= (sel-start (view-primary (current-view))) first)))
(exercise "m i (" '("call(wrong, args)") '("m" "i" "(" "c" (t "right") "esc") '("call(right)") 0 7)
(exercise "m s (" '("wrap me") '("w" "w" "m" "s" "(") '("wrap (me)") 0 0)
(exercise "m d (" '("free (this) word") '("m" "d" "(") '("free this word") 0 7)

;; Lesson 8
(exercise "a macro" '("apple" "banana" "cherry")
          '("Q" "I" (t "- ") "esc" "j" "Q" "2" "q") '("- apple" "- banana" "- cherry") 0 0)

;; Lesson 9: *tutor* has no file, so :w asks where.
(press! ":")
(type! "w")
(press! "enter")
(check ":w asks" (and (current-prompt) (equal? (prompt-label (current-prompt)) "save as:")))
(press! "esc")

;; Lesson 10
(press! "space" "e")
(type! "(message \"Hello from ~a\" (scheme-version))")
(press! "enter")
(check "eval" (string-contains (screen-row 29) "Hello from Chez Scheme"))
(press! "space" "space")
(type! "tutor")
(press! "enter")
(check "a fresh copy" (equal? (buffer-contents) helix-tutor-text))

(set-var! 'key-scheme 'ki)
