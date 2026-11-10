;; highlight.ss -- highlighting after edits lexes only as far as it must,
;; and always agrees with highlighting from scratch
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The lexer here counts the lines it lexes. Its state is whether a line
;; starts inside a string (#t; the first line's state is 0) -- a " opens
;; or closes one -- and the span it emits for a line says so, so comparing
;; spans compares states.

(define lexed 0)

(define (string-lexer text s e state emit)
  (set! lexed (+ lexed 1))
  (emit s e (if (eq? state #t) 'string 'plain))
  (let loop ([i s] [st (eq? state #t)])
    (cond
     [(= i e) st]
     [(char=? (text-ref text i) #\") (loop (+ i 1) (not st))]
     [else (loop (+ i 1) st)])))

(define (make-lexer name)
  (make-syntax name #f '() '() '() default-word-char? (keyword-table) '() string-lexer #f "  "))

(define strings (make-lexer 'strings))

(define (line-pos b l) (text-line-start (buffer-text b) l))

;; Lines first to last, through the buffer's cache, and the number lexed.
(define (highlight b first last)
  (set! lexed 0)
  (let ([spans (highlight-region strings (buffer-text b) (buffer-hl-cache b) first last)])
    (values spans lexed)))

;; Whether the cache's highlighting of first to last is a fresh cache's.
(define (agrees? b first last)
  (let-values ([(spans n) (highlight b first last)])
    (equal? spans (highlight-region strings (buffer-text b) (make-hl-cache) first last))))

(define (lines n)
  (apply string-append (map (lambda (i) (format "(line ~a)\n" i)) (iota n))))

;; An edit at the top, with the view far below: the states agree again a
;; checkpoint down, and the lexing picks up from the last one above the view.
(let ([b (new-buffer! "hl-top" (lines 3000) fundamental-mode)])
  (highlight b 2900 2920)
  (buffer-insert! b 0 "x")
  (let-values ([(spans n) (highlight b 2900 2920)])
    (check "an edit far above lexes a little" (< n 200)))
  (check "and agrees" (agrees? b 2900 2920))
  ;; A line added and one taken away shift the checkpoints below.
  (buffer-insert! b (line-pos b 10) "(new)\n")
  (check "after a line added" (agrees? b 2900 2920))
  (buffer-delete! b (line-pos b 20) (line-pos b 21))
  (check "after a line taken away" (agrees? b 2900 2920))
  (buffer-delete! b (line-pos b 100) (line-pos b 500))
  (check "after many taken away" (agrees? b 2400 2499))
  (let-values ([(spans n) (highlight b 2400 2420)])
    (check "and again a little" (< n 200))))

;; Opening a string at the top changes every line below; closing it again
;; changes them back.
(let ([b (new-buffer! "hl-string" (lines 2000) fundamental-mode)])
  (highlight b 1900 1920)
  (buffer-insert! b 0 "\"")
  (check "an open string reaches the view" (agrees? b 1900 1920))
  (let-values ([(spans n) (highlight b 1900 1900)])
    (check "string" (equal? (caddr (car (vector-ref spans 0))) 'string)))
  (buffer-delete! b 0 1)
  (check "closed again" (agrees? b 1900 1920)))

;; Two edits apart, the view between them: lexing as far as the view must
;; not vouch for the states below the lower edit, which opened a string.
(let ([b (new-buffer! "hl-two" (lines 3000) fundamental-mode)])
  (highlight b 2900 2920)
  (buffer-insert! b (line-pos b 1500) "\"")
  (buffer-insert! b (line-pos b 5) "y")
  (check "between the edits" (agrees? b 0 30))
  (check "below the lower edit" (agrees? b 2900 2920))
  ;; Again, with the view between them looked at after each edit.
  (buffer-delete! b (line-pos b 1500) (+ 1 (line-pos b 1500)))
  (highlight b 200 220)
  (buffer-insert! b (line-pos b 10) "z")
  (highlight b 100 120)
  (check "below, once closed" (agrees? b 2900 2920)))

;; Edits all over, multiple at once too, and the view all over: every
;; highlighting agrees with a fresh one.
(let ([b (new-buffer! "hl-many" (lines 1500) fundamental-mode)]
      [seed 12345])
  (define (next! n)
    (set! seed (mod (+ (* seed 1103515245) 12345) 2147483648))
    (mod (quotient seed 65536) n))
  (let loop ([i 0] [ok #t])
    (if (= i 150)
        (check "edits all over agree" ok)
        (let* ([count (text-line-count (buffer-text b))]
               [l (next! count)]
               [p (line-pos b l)])
          (case (next! 5)
            [(0) (buffer-insert! b p "\"")]
            [(1) (buffer-insert! b p (lines (+ 1 (next! 100))))]
            [(2) (buffer-delete! b p (line-pos b (min (- count 1) (+ l (next! 150)))))]
            [(3) (buffer-edit! b (list (list p p "\"")
                                       (let ([q (line-pos b (min (- count 1) (+ l 1 (next! 300))))]) (list q q "\"\n"))))]
            [else (buffer-insert! b p "word")])
          (let* ([count (text-line-count (buffer-text b))]
                 [top (next! count)])
            (loop (+ i 1) (and ok (agrees? b top (min (- count 1) (+ top 40))))))))))

;; Another lexer's states are no use: changing it starts again.
(let ([b (new-buffer! "hl-mode" (string-append "\"\n" (lines 500)) fundamental-mode)])
  (highlight b 400 410)
  (let ([spans (highlight-region plain-syntax (buffer-text b) (buffer-hl-cache b) 400 410)])
    (check "another lexer"
           (equal? spans (highlight-region plain-syntax (buffer-text b) (make-hl-cache) 400 410))))
  (check "and back" (agrees? b 400 410)))
