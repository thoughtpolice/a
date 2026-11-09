;; tutor.ss -- the tutor's exercises, done with the keys its lessons give
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Each exercise is a few indented lines, then what they should become, as
;; "  ✓ " lines. The fake terminal has no key releases, so a layer key's
;; tap is pressed twice ("r" "r"), as the tutor says to.

(headless-start! 30 100)
(press! "space" "k" "h")
(check "the tutor" (and (equal? (buffer-name (current-buffer)) "*tutor*")
                        (equal? (buffer-contents) tutor-text)
                        (string-contains (screen-row 0) "*tutor*")))
(check "in markdown mode" (string-contains (screen-row 28) "markdown"))
(check "at its start" (equal? (primary-text) "#"))

(define (block lines) (apply string-append (map (lambda (l) (string-append "\n    " l)) lines)))

;; Put the cursor at the start of lines' line number start (in CHAR mode,
;; where the tutor leaves you), press keys, and compare with result.
(define (exercise name lines keys result . start)
  (for-each (lambda (r)
              (check (format "~a: the tutor shows ~s" name r)
                     (string-contains tutor-text (string-append "\n  ✓ " r "\n"))))
            result)
  (let ([i (string-contains (buffer-contents) (string-append (block lines) "\n"))])
    (if (not i)
        (begin (failure!) (printf "FAIL ~a: the tutor has no such lines\n" name))
        (let ([at (let loop ([pos (+ i 1)] [n (if (pair? start) (car start) 0)])
                    (if (= n 0) pos (loop (+ (string-index (buffer-contents) #\newline pos) 1) (- n 1))))])
          (set-selection-mode! (current-buffer) 'char)
          (set-primary! (make-sel at (+ at 1)))
          (for-each (lambda (k) (if (string? k) (press! k) (type! (cadr k)))) keys)
          (check name (string-contains (buffer-contents) (string-append (block result) "\n")))
          (press! "esc" "esc" "W")))))

;; Lesson 3
(exercise "delete the doubled words" '("The the cat sat on the the mat.")
          '("s" "y" "l" "r" "r" "l" "l" "l" "r" "r") '("The cat sat on the mat."))
(exercise "delete a line" '("Keep this line." "Delete this line." "Keep this line too.")
          '("a" "r" "r") '("Keep this line." "Keep this line too.") 1)
(press! "z" "z")
(check "undo" (string-contains (buffer-contents) (block '("Keep this line." "Delete this line." "Keep this line too."))))
(press! "Z")
(check "redo" (not (string-contains (buffer-contents) (block '("Keep this line." "Delete this line.")))))

;; Lesson 4
(exercise "insert before" '("quad is editor.") '("s" "y" "l" "l" "h" (t "an ") "esc") '("quad is an editor."))
(exercise "append" '("Hello, world") '("s" "p" ";" (t "!") "esc") '("Hello, world!"))
(press! "h")
(check "INS while inserting" (string-contains (screen-row 28) " INS "))
(press! "esc")
(exercise "change" '("The sky is green.") '("s" "y" "l" "l" "l" "g" "g" (t "blue") "esc") '("The sky is blue."))
(exercise "open a line" '("first" "third") '("a" "g" "k" (t "second") "esc") '("first" "second" "third"))

;; Lesson 5
(exercise "copy and paste after" '("one two three") '("s" "y" "c" "c" "l" "v" "l") '("one two one three"))
(exercise "cut and paste below" '("2. second" "1. first" "3. third") '("a" "x" "x" "v" "k")
          '("1. first" "2. second" "3. third"))

;; Lesson 6
(exercise "extend" '("one two three four") '("s" "y" "f" "l" "l" "r" "r") '("four"))
(press! "f")
(check "EXT while extending" (string-contains (screen-row 28) " EXT "))
(press! "esc")
(exercise "every occurrence" '("cat dog cat bird cat") '("s" "y" "n" "n" "g" "g" (t "cow") "esc" "esc")
          '("cow dog cow bird cow"))
(check "back to one selection" (= (length (view-sels (current-view))) 1))
(exercise "swap" '("brown quick fox") '("s" "y" "t" "l") '("quick brown fox"))

;; Lesson 7: search, then the next match.
(define haystack "hay hay hay needle hay hay hay hay needle hay")
(let ([i (string-contains (buffer-contents) (block (list haystack)))])
  (set-primary! (make-sel (+ i 1) (+ i 2)))
  (press! "n" "d")
  (type! "needle")
  (press! "enter")
  (let ([first (sel-start (view-primary (current-view)))])
    (check "found" (and (equal? (primary-text) "needle") (= first (+ i 5 (string-contains haystack "needle")))))
    (press! "l")
    (check "the next" (and (equal? (primary-text) "needle") (> (sel-start (view-primary (current-view))) first)))
    (press! "j")
    (check "and back" (= (sel-start (view-primary (current-view))) first))))
(press! "esc" "W")
(press! "M")
(type! "1")
(press! "enter")
(check "M goes to a line" (= (sel-start (view-primary (current-view))) 0))
(let ([row (screen-row 1)])
  (press! "m")
  (check "m labels the words" (not (equal? (screen-row 1) row))))
(press! "esc" "W")

;; Lesson 8
(let ([i (string-contains (buffer-contents) (block '("(+ 1 (* 2 3))")))])
  (set-primary! (make-sel (+ i 1) (+ i 2)))
  (press! "d")
  (check "a node" (equal? (primary-text) "(+ 1 (* 2 3))"))
  (press! "k")
  (check "its first child" (equal? (primary-text) "+"))
  (press! "l" "l")
  (check "siblings" (equal? (primary-text) "(* 2 3)"))
  (press! "k")
  (check "in" (equal? (primary-text) "*"))
  (press! "i")
  (check "out" (equal? (primary-text) "(* 2 3)"))
  (press! "esc" "W"))
(exercise "delete a node" '("(+ 1 (* 2 3))") '("d" "k" "l" "r" "r") '("(+ (* 2 3))"))
(exercise "surround" '("wrap me") '("s" "p" "," "s" "m") '("wrap (me)"))
(exercise "unsurround" '("free (this) word") '("s" "y" "l" "," "r" "m") '("free this word"))
(exercise "upper case" '("make this loud") '("s" "p" "F" "q") '("make this LOUD"))
(exercise "join" '("a line broken" "in two") '("I") '("a line broken in two"))

;; Lesson 9: *tutor* has no file, so saving asks where.
(press! "enter")
(check "save asks" (and (current-prompt) (equal? (prompt-label (current-prompt)) "save as:")))
(press! "esc")

;; Lesson 10
(press! "space" "e")
(type! "(message \"Hello from ~a\" (scheme-version))")
(press! "enter")
(check "eval" (string-contains (screen-row 29) "Hello from Chez Scheme"))
(press! "space" "space")
(type! "tutor")
(press! "enter")
(check "a fresh copy" (and (equal? (buffer-contents) tutor-text) (equal? (primary-text) "#")
                           (= 1 (length (filter (lambda (b) (string-prefix? "*tutor*" (buffer-name b))) (buffers))))))
