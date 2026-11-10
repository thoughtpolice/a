;; text.sls -- buffer text: a rope, in the kernel, with a window onto it here
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Positions are character offsets in [0, length]. Lines are separated by
;; #\newline; line n starts after the n-th newline. The text is a rope in
;; the Rust half (kernel/text/, on ropey), so an edit or a lookup of a
;; line takes time in the logarithm of the text's size, however big it is.
;;
;; A call into Rust costs ten times a string-ref, and the highlighter,
;; movements and searches read a character at a time: text-ref reads from
;; a window of the text kept here, a string of a few thousand characters
;; around the last one read, fetched again when a read falls outside it.
;; An edit closes the window.
(library (quad text)
  (export make-text read-text-file text? text-rope text-length text-ref text-substring text->string
          text-insert! text-delete! text-version
          text-line-count text-line-start text-line-end text-line-of
          text-line-string text-column text-pos-at text-match-at?
          text-search-forward text-search-backward)
  (import (chezscheme)
          (only (quad native) rope-new rope-read rope-length rope-line-count rope-line-start rope-line-end
                rope-line-of rope-slice rope-insert! rope-remove! rope-find-forward
                rope-find-backward))

  ;; rope: the kernel's. len: its length, kept here, as it is asked for
  ;; often. window: the text from window-start on, "" when closed.
  (define-record-type text
    (fields rope (mutable len) (mutable version) (mutable window-start) (mutable window))
    (protocol
     (lambda (new)
       (case-lambda
        [() (new (rope-new "") 0 0 0 "")]
        ;; A string, or a rope from rope-read.
        [(s) (if (string? s)
                 (new (rope-new s) (string-length s) 0 0 "")
                 (new s (rope-length s) 0 0 ""))]))))

  ;; The text of the file at path, as UTF-8 (what is not, U+FFFD), read in
  ;; the kernel.
  (define (read-text-file path) (make-text (rope-read path)))

  (define (text-length t) (text-len t))

  ;; A window is this many characters, from this many before the one read:
  ;; reads that move backwards (a movement left, a search back) fetch as
  ;; seldom as those that move forwards.
  (define window-size 4096)
  (define window-before 2048)

  (define (text-ref t i)
    (let ([j (- i (text-window-start t))] [w (text-window t)])
      (if (and (fixnum? j) (fx>= j 0) (fx< j (string-length w)))
          (string-ref w j)
          (begin
            (unless (and (fixnum? i) (fx>= i 0) (fx< i (text-len t)))
              (errorf 'text-ref "~s is not a position in a text of ~s characters" i (text-len t)))
            (let* ([s (max 0 (- i window-before))]
                   [w (rope-slice (text-rope t) s (+ s window-size))])
              (text-window-start-set! t s)
              (text-window-set! t w)
              (string-ref w (- i s)))))))

  (define (text-substring t s e)
    (let ([s (max 0 s)] [e (min e (text-len t))])
      (cond
       [(>= s e) ""]
       ;; Within the window: no call needed (a line drawn, a word read).
       [(let ([ws (text-window-start t)])
          (and (>= s ws) (<= e (+ ws (string-length (text-window t))))))
        (let ([ws (text-window-start t)]) (substring (text-window t) (- s ws) (- e ws)))]
       [else (rope-slice (text-rope t) s e)])))

  (define (text->string t) (text-substring t 0 (text-len t)))

  (define (edited! t)
    (text-window-set! t "")
    (text-version-set! t (+ 1 (text-version t))))

  (define (text-insert! t pos s)
    (let ([n (string-length s)])
      (when (> n 0)
        (rope-insert! (text-rope t) (max 0 (min pos (text-len t))) s)
        (text-len-set! t (+ (text-len t) n))
        (edited! t))))

  (define (text-delete! t s e)
    (let ([s (max 0 s)] [e (min e (text-len t))])
      (when (< s e)
        (rope-remove! (text-rope t) s e)
        (text-len-set! t (- (text-len t) (- e s)))
        (edited! t))))

  (define (text-line-count t) (rope-line-count (text-rope t)))

  ;; Where line starts, the line clamped to the text's.
  (define (text-line-start t line) (rope-line-start (text-rope t) (max 0 line)))

  ;; The position of line's newline, or the end of the text.
  (define (text-line-end t line) (rope-line-end (text-rope t) (max 0 line)))

  (define (text-line-string t line)
    (text-substring t (text-line-start t line) (text-line-end t line)))

  ;; The line containing pos.
  (define (text-line-of t pos) (rope-line-of (text-rope t) (max 0 pos)))

  (define (text-column t pos) (- pos (text-line-start t (text-line-of t pos))))

  ;; The position at `col` characters into `line`, clamped to the line.
  (define (text-pos-at t line col)
    (let ([s (text-line-start t line)] [e (text-line-end t line)])
      (min e (+ s (max 0 col)))))

  ;; Whether needle is in t at i; with fold?, in either case.
  (define text-match-at?
    (case-lambda
     [(t i needle) (text-match-at? t i needle #f)]
     [(t i needle fold?)
      (let ([m (string-length needle)] [same? (if fold? char-ci=? char=?)])
        (and (>= i 0) (<= (+ i m) (text-length t))
             (let loop ([j 0])
               (or (= j m)
                   (and (same? (text-ref t (+ i j)) (string-ref needle j))
                        (loop (+ j 1)))))))]))

  ;; Where needle first occurs at or after pos, or #f.
  (define (text-search-forward t needle pos)
    (and (> (string-length needle) 0)
         (rope-find-forward (text-rope t) needle (max 0 pos))))

  ;; Where needle last occurs starting at or before pos, or #f.
  (define (text-search-backward t needle pos)
    (and (> (string-length needle) 0) (>= pos 0)
         (rope-find-backward (text-rope t) needle pos))))
