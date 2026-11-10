;; tutor-vim.ss -- the Vim tutor's exercises, done with the keys its
;; lessons give
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; As tutor.ss does Ki's: each exercise is a few indented lines, then what
;; they should become, as "  ✓ " lines.

(headless-start! 30 100)
(set-var! 'key-scheme 'vim)
(press! "space" "k" "h")
(check "the Vim tutor" (and (equal? (buffer-name (current-buffer)) "*tutor*")
                            (equal? (buffer-contents) vim-tutor-text)
                            (string-contains vim-tutor-text "with Vim's keys")))

(define (block lines) (apply string-append (map (lambda (l) (string-append "\n    " l)) lines)))

;; Put the cursor on lines' line number line (of them), column column,
;; press keys (a list (t "text") types text), and compare with result.
(define (exercise name lines keys result line column)
  (for-each (lambda (r)
              (check (format "~a: the tutor shows ~s" name r)
                     (string-contains vim-tutor-text (string-append "\n  ✓ " r "\n"))))
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
(exercise "x" '("The ccow jumpedd over thhe moon.")
          '("l" "l" "l" "l" "x" "w" "e" "x" "w" "w" "l" "x") '("The cow jumped over the moon.") 0 0)
(exercise "dw" '("The cat the the sat on the the mat.")
          '("w" "w" "w" "d" "w" "w" "w" "w" "d" "w") '("The cat the sat on the mat.") 0 0)
(exercise "dd" '("Keep this line." "Delete this line." "Keep this line too.")
          '("d" "d") '("Keep this line." "Keep this line too.") 1 0)
(press! "u")
(check "u" (string-contains (buffer-contents) (block '("Keep this line." "Delete this line." "Keep this line too."))))
(press! "ctrl+r")
(check "ctrl+r" (not (string-contains (buffer-contents) (block '("Keep this line." "Delete this line.")))))
(exercise "d2w" '("a red blue sky") '("w" "d" "2" "w") '("a sky") 0 0)

;; Lesson 3
(exercise "i" '("quad is editor.") '("w" "w" "i" (t "an ") "esc") '("quad is an editor.") 0 0)
(exercise "A" '("Hello, world") '("A" (t "!") "esc") '("Hello, world!") 0 0)
(press! "i")
(check "INS while inserting" (string-contains (screen-row 28) " INS "))
(press! "esc")
(exercise "o" '("first" "third") '("o" (t "second") "esc") '("first" "second" "third") 0 0)

;; Lesson 4
(exercise "cw" '("The sky is green.") '("w" "w" "w" "c" "w" (t "blue") "esc") '("The sky is blue.") 0 0)
(exercise "C" '("This line is wrong in its second half.") '("w" "w" "C" (t "was fixed.") "esc")
          '("This line was fixed.") 0 0)
(exercise "r" '("Wxth a tyPo") '("l" "r" "i" "w" "w" "l" "l" "r" "p") '("With a typo") 0 0)

;; Lesson 5
(exercise "ci(" '("call(wrong, args)") '("c" "i" "(" (t "right") "esc") '("call(right)") 0 7)
(exercise "daw" '("please delete this") '("d" "a" "w") '("please this") 0 9)
(exercise "di\"" '("say \"nothing at all\" now") '("d" "i" "\"") '("say \"\" now") 0 8)

;; Lesson 6
(exercise "yw P" '("one two three") '("y" "w" "w" "P") '("one one two three") 0 0)
(exercise "dd p" '("2. second" "1. first" "3. third") '("d" "d" "p") '("1. first" "2. second" "3. third") 0 0)
(exercise "registers" '("keep me" "drop me")
          '("\"" "k" "y" "y" "j" "d" "d" "k" "\"" "k" "p") '("keep me" "keep me") 0 0)

;; Lesson 7
(exercise "v e e l d" '("one two three four") '("v" "e" "e" "l" "d") '("three four") 0 0)
(exercise "V j d" '("alpha" "beta" "gamma") '("V" "j" "d") '("gamma") 0 0)
(exercise "v i w U" '("make this loud") '("v" "i" "w" "U") '("make this LOUD") 0 11)

;; Lesson 8: search, then the next match and back.
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
(let* ([line "one, two, three, four"] [i (string-contains (buffer-contents) (block (list line)))])
  (set-primary! (make-sel (+ i 5) (+ i 6)))
  (press! "f" "," ";" ";")
  (check "f ; ;" (= (sel-start (view-primary (current-view))) (+ i 5 15))))
(press! ":")
(type! "1")
(press! "enter")
(check ":1 goes to a line" (= (sel-start (view-primary (current-view))) 0))

;; Lesson 9
(exercise "." '("x = 1" "y = 2" "z = 3") '("A" (t ";") "esc" "j" "." "j" ".") '("x = 1;" "y = 2;" "z = 3;") 0 0)
(exercise "dw . ." '("a very very very long line") '("w" "d" "w" "." ".") '("a long line") 0 0)
(exercise "a macro" '("apple" "banana" "cherry")
          '("q" "a" "I" (t "- ") "esc" "j" "q" "2" "@" "a") '("- apple" "- banana" "- cherry") 0 0)

;; Lesson 10: *tutor* has no file, so :w asks where.
(press! ":")
(type! "w")
(press! "enter")
(check ":w asks" (and (current-prompt) (equal? (prompt-label (current-prompt)) "save as:")))
(press! "esc")
(press! "space" "e")
(type! "(message \"Hello from ~a\" (scheme-version))")
(press! "enter")
(check "eval" (string-contains (screen-row 29) "Hello from Chez Scheme"))
(press! "space" "space")
(type! "tutor")
(press! "enter")
(check "a fresh copy" (equal? (buffer-contents) vim-tutor-text))

(set-var! 'key-scheme 'ki)
