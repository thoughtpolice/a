;; text.ss -- the text (a rope, with a window onto it), lines, and undo
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

;; Big edits, bigger than the window text-ref reads through.
(let ([big (make-string 10000 #\x)])
  (text-insert! t 3 big)
  (expect-equal "grow" (text-length t) (+ 12 10000))
  (text-delete! t 3 10003)
  (expect-equal "shrink" (text->string t) "there\nworld\n"))

;; Reading a character at a time, forwards and backwards across the
;; window's edges, and after edits that close it, agrees with the string.
(let* ([s (list->string (map (lambda (i) (integer->char (+ 97 (mod (* i 7) 26)))) (iota 20000)))]
       [lt (make-text s)]
       [agrees? (lambda (s)
                  (and (= (text-length lt) (string-length s))
                       (let loop ([i 0])
                         (or (= i (string-length s))
                             (and (char=? (text-ref lt i) (string-ref s i)) (loop (+ i 1)))))
                       (let loop ([i (- (string-length s) 1)])
                         (or (< i 0)
                             (and (char=? (text-ref lt i) (string-ref s i)) (loop (- i 1)))))))])
  (check "text-ref, both ways" (agrees? s))
  (text-ref lt 5000)
  (text-insert! lt 5001 "NEW")
  (check "text-ref after an insert in the window" (agrees? (string-append (substring s 0 5001) "NEW" (substring s 5001 20000))))
  (expect-equal "a substring across the window's edge" (text-substring lt 4090 4110)
                (substring (string-append (substring s 0 5001) "NEW" (substring s 5001 20000)) 4090 4110))
  (check "text-ref out of the text is an error" (guard (e [#t #t]) (text-ref lt 20003) #f)))

;; A file is read as UTF-8, its line endings kept, what is not UTF-8
;; replaced with U+FFFD.
(let ([path (path-join (test-temp-dir "text") "odd.txt")])
  (call-with-port (open-file-output-port path (file-options no-fail))
    (lambda (p) (put-bytevector p (bytevector 97 13 10 98 255 254 99 10 230 151 165))))
  (expect-equal "read-text-file" (text->string (read-text-file path)) "a\r\nb\xFFFD;\xFFFD;c\n日"))

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
