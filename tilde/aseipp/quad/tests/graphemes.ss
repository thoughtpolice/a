;; graphemes.ss -- emoji sequences and marks, as one character each
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A grapheme cluster shows in one place: a flag (two regional
;; indicators), a family (emoji joined by zero-width joiners), an emoji
;; with its skin tone, a character with its marks. The editor counts its
;; columns, moves over it and deletes it whole, as terminals that cluster
;; graphemes (mode 2027) draw it.

(headless-start! 10 40)

;; ---------------------------------------------------------------------------
;; Clusters and their columns

(define family "👨\x200D;👩\x200D;👧")
(define flag "🇯🇵")
(expect-equal "a flag is one cluster of two columns"
              (list (string-graphemes "🇯🇵🇫🇷") (string-width "🇯🇵🇫🇷"))
              '(("🇯🇵" "🇫🇷") 4))
(expect-equal "a lone regional indicator is its own"
              (string-graphemes "🇯🇵🇫") '("🇯🇵" "🇫"))
(expect-equal "a family is one cluster of two columns"
              (list (string-graphemes (string-append family "x")) (string-width family))
              (list (list family "x") 2))
(expect-equal "a skin tone joins its emoji" (string-graphemes "👍🏽!") '("👍🏽" "!"))
(expect-equal "an emoji asked for as a picture takes two columns"
              (map string-width '("❤\xFE0F;" "❤" "1\xFE0F;\x20E3;"))
              '(2 1 2))
(expect-equal "a mark joins its character"
              (list (string-graphemes "e\x301;x") (string-width "e\x301;x"))
              '(("e\x301;" "x") 2))
(expect-equal "a tag sequence (Scotland's flag) is one"
              (length (string-graphemes "🏴\xE0067;\xE0062;\xE0073;\xE0063;\xE0074;\xE007F;"))
              1)
(expect-equal "a newline is always its own"
              (string-graphemes (string-append "a" (string #\newline) "\x301;"))
              (list "a" (string #\newline) "\x301;"))

;; ---------------------------------------------------------------------------
;; In a buffer: drawn, counted, moved over and deleted whole

(define text (string-append "a" flag "b" family "c\n"))
(define b (headless-buffer! text 'text))
(redraw!)
(check "the line shows each cluster in its place"
       (exists (lambda (row) (string-contains row (string-append "a" flag "b" family "c"))) (screen)))
(define (position-of s) (string-contains text s))
(expect-equal "columns count clusters"
              (map (lambda (s) (display-column b (position-of s))) (list "b" "c"))
              '(3 6))
(expect-equal "moving right steps over whole clusters"
              (let loop ([p 0] [acc '()])
                (if (>= p (position-of "\n")) (reverse acc) (loop (grapheme-after b p) (cons p acc))))
              (list 0 1 3 4 9))
(expect-equal "and moving left"
              (map (lambda (p) (grapheme-before b p)) (list 9 4 3 1))
              (list 4 3 1 0))
