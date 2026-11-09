;; text.ss -- the gap buffer, line index, and undo
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define t (make-text "hello\nworld\n"))
(expect-equal "length" (text-length t) 12)
(expect-equal "lines" (text-line-count t) 3)
(expect-equal "line 1" (text-line-string t 1) "world")
(expect-equal "line of 7" (text-line-of t 7) 1)
(text-insert! t 5 ", there")
(expect-equal "insert" (text->string t) "hello, there\nworld\n")
(text-delete! t 0 7)
(expect-equal "delete" (text->string t) "there\nworld\n")
(expect-equal "line start after edits" (text-line-start t 1) 6)
(expect-equal "search" (text-search-forward t "wor" 0) 6)
(expect-equal "search backward" (text-search-backward t "e" 11) 4)

;; Big edits grow the gap.
(let ([big (make-string 10000 #\x)])
  (text-insert! t 3 big)
  (expect-equal "grow" (text-length t) (+ 12 10000))
  (text-delete! t 3 10003)
  (expect-equal "shrink" (text->string t) "there\nworld\n"))

;; Buffers: grouped undo, fine undo, redo.
(define b (make-buffer "t" #f "one two three" fundamental-mode))
(buffer-begin-group! b)
(buffer-edit! b '((0 3 "1")))
(buffer-edit! b '((2 5 "2")))
(buffer-end-group! b)
(expect-equal "edits" (buffer-string b) "1 2 three")
(buffer-undo! b #t)
(expect-equal "fine undo" (buffer-string b) "1 two three")
(buffer-undo! b #f)
(expect-equal "coarse undo" (buffer-string b) "one two three")
(buffer-redo! b)
(expect-equal "redo" (buffer-string b) "1 two three")

;; Several changes at once, in any order, report where each landed.
(define b2 (make-buffer "t2" #f "aaa bbb ccc" fundamental-mode))
(expect-equal "multi-edit starts" (buffer-edit! b2 '((8 11 "C") (0 3 "AAAA"))) '(9 0))
(expect-equal "multi-edit text" (buffer-string b2) "AAAA bbb C")
(buffer-undo! b2 #f)
(expect-equal "multi-edit undo" (buffer-string b2) "aaa bbb ccc")

;; Fuzzy matching prefers word starts and runs.
(check "fuzzy" (> (car (fuzzy-score "qd" "quad/display.sls")) (car (fuzzy-score "qd" "aqbd"))))
(check "fuzzy miss" (not (fuzzy-score "zz" "quad")))

;; The line index stays right through edits that add and remove lines.
(define lt (make-text "a\nbb\nccc\n"))
(text-line-count lt)
(text-insert! lt 1 "\nX\nY")
(text-delete! lt 6 9)
(expect-equal "incremental line index"
              (map (lambda (l) (text-line-start lt l)) (iota (text-line-count lt)))
              (let ([fresh (make-text (text->string lt))])
                (map (lambda (l) (text-line-start fresh l)) (iota (text-line-count fresh)))))

;; Columns, as terminals count them: emoji shown as pictures take two,
;; their text-style neighbors one.
(expect-equal "widths"
              (map char-width (string->list "a界😀⚡✅🫠☀✔\x301;"))
              '(1 2 2 2 2 2 1 1 0))
