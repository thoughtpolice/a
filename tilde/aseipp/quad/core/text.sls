;; text.sls -- buffer text: a gap buffer of characters, with a line index
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Positions are character offsets in [0, length]. Lines are separated by
;; #\newline; line n starts after the n-th newline. The line index, a vector
;; of line starts, is built on first use and then updated by each edit, in
;; time proportional to the number of lines rather than characters.
(library (quad text)
  (export make-text text? text-length text-ref text-substring text->string
          text-insert! text-delete! text-version
          text-line-count text-line-start text-line-end text-line-of
          text-line-string text-column text-pos-at
          text-search-forward text-search-backward)
  (import (chezscheme))

  (define-record-type text
    (fields (mutable buf) (mutable gs) (mutable ge)
            (mutable lines) (mutable version))
    (protocol
     (lambda (new)
       (case-lambda
        [() (new (make-string 64) 0 64 #f 0)]
        [(s)
         (let* ([n (string-length s)]
                [cap (+ n 64)]
                [buf (make-string cap)])
           (string-copy! s 0 buf 0 n)
           (new buf n cap #f 0))]))))

  (define (text-length t) (- (string-length (text-buf t)) (- (text-ge t) (text-gs t))))

  (define (text-ref t i)
    (let ([gs (text-gs t)])
      (string-ref (text-buf t) (if (< i gs) i (+ i (- (text-ge t) gs))))))

  (define (text-substring t s e)
    (let* ([s (max 0 s)] [e (min e (text-length t))]
           [out (make-string (max 0 (- e s)))]
           [gs (text-gs t)] [gap (- (text-ge t) gs)] [buf (text-buf t)])
      (when (< s e)
        (cond
         [(<= e gs) (string-copy! buf s out 0 (- e s))]
         [(>= s gs) (string-copy! buf (+ s gap) out 0 (- e s))]
         [else
          (string-copy! buf s out 0 (- gs s))
          (string-copy! buf (text-ge t) out (- gs s) (- e gs))]))
      out))

  (define (text->string t) (text-substring t 0 (text-length t)))

  (define (move-gap! t pos)
    (let ([gs (text-gs t)] [ge (text-ge t)] [buf (text-buf t)])
      (cond
       [(< pos gs)
        (let ([n (- gs pos)])
          (string-copy! buf pos buf (- ge n) n)
          (text-gs-set! t pos)
          (text-ge-set! t (- ge n)))]
       [(> pos gs)
        (let ([n (- pos gs)])
          (string-copy! buf ge buf gs n)
          (text-gs-set! t pos)
          (text-ge-set! t (+ ge n)))])))

  (define (ensure-gap! t n)
    (when (< (- (text-ge t) (text-gs t)) n)
      (let* ([buf (text-buf t)] [len (string-length buf)]
             [tail (- len (text-ge t))]
             [cap (max (* 2 len) (+ len n 64))]
             [new (make-string cap)])
        (string-copy! buf 0 new 0 (text-gs t))
        (string-copy! buf (text-ge t) new (- cap tail) tail)
        (text-buf-set! t new)
        (text-ge-set! t (- cap tail)))))

  (define (touch! t)
    (text-version-set! t (+ 1 (text-version t))))

  ;; The index of the first line start greater than pos.
  (define (first-start-after v pos)
    (let loop ([lo 0] [hi (vector-length v)])
      (if (>= lo hi) lo
          (let ([mid (quotient (+ lo hi) 2)])
            (if (<= (vector-ref v mid) pos) (loop (+ mid 1) hi) (loop lo mid))))))

  ;; Update the line index for s inserted at pos.
  (define (index-insert! t pos s)
    (let ([v (text-lines t)])
      (when v
        (let* ([n (string-length s)]
               [new (let loop ([i (- n 1)] [acc '()])
                      (cond [(< i 0) acc]
                            [(char=? (string-ref s i) #\newline) (loop (- i 1) (cons (+ pos i 1) acc))]
                            [else (loop (- i 1) acc)]))]
               [k (first-start-after v pos)]
               [m (length new)]
               [out (make-vector (+ (vector-length v) m))])
          (do ([i 0 (+ i 1)]) ((= i k)) (vector-set! out i (vector-ref v i)))
          (let loop ([l new] [i k]) (unless (null? l) (vector-set! out i (car l)) (loop (cdr l) (+ i 1))))
          (do ([i k (+ i 1)]) ((= i (vector-length v)))
            (vector-set! out (+ i m) (+ n (vector-ref v i))))
          (text-lines-set! t out)))))

  ;; Update the line index for [s, e) deleted.
  (define (index-delete! t s e)
    (let ([v (text-lines t)])
      (when v
        (let* ([k (first-start-after v s)]   ; starts in (s, e] go
               [j (first-start-after v e)]
               [gone (- j k)]
               [out (make-vector (- (vector-length v) gone))])
          (do ([i 0 (+ i 1)]) ((= i k)) (vector-set! out i (vector-ref v i)))
          (do ([i j (+ i 1)]) ((= i (vector-length v)))
            (vector-set! out (- i gone) (- (vector-ref v i) (- e s))))
          (text-lines-set! t out)))))

  (define (text-insert! t pos s)
    (let ([n (string-length s)])
      (when (> n 0)
        (move-gap! t pos)
        (ensure-gap! t n)
        (string-copy! s 0 (text-buf t) (text-gs t) n)
        (text-gs-set! t (+ (text-gs t) n))
        (index-insert! t pos s)
        (touch! t))))

  (define (text-delete! t s e)
    (when (< s e)
      (move-gap! t s)
      (text-ge-set! t (+ (text-ge t) (- e s)))
      (index-delete! t s e)
      (touch! t)))

  ;; A vector of line start positions, built by scanning both sides of
  ;; the gap.
  (define (line-index t)
    (or (text-lines t)
        (let ([buf (text-buf t)] [gs (text-gs t)] [ge (text-ge t)])
          (let ([acc (let scan ([i 0] [end gs] [offset 0] [acc '(0)])
                       (cond
                        [(< i end)
                         (scan (+ i 1) end offset
                               (if (char=? (string-ref buf i) #\newline) (cons (+ i offset 1) acc) acc))]
                        [(= end gs) (scan ge (string-length buf) (- gs ge) acc)]
                        [else acc]))])
            (let ([v (list->vector (reverse acc))])
              (text-lines-set! t v)
              v)))))

  (define (text-line-count t) (vector-length (line-index t)))

  (define (text-line-start t line)
    (let ([v (line-index t)])
      (vector-ref v (max 0 (min line (- (vector-length v) 1))))))

  ;; The position of line's newline, or the end of the text.
  (define (text-line-end t line)
    (let ([v (line-index t)])
      (if (>= (+ line 1) (vector-length v))
          (text-length t)
          (- (vector-ref v (+ line 1)) 1))))

  (define (text-line-string t line)
    (text-substring t (text-line-start t line) (text-line-end t line)))

  ;; The line containing pos, by binary search.
  (define (text-line-of t pos)
    (let ([v (line-index t)])
      (let loop ([lo 0] [hi (- (vector-length v) 1)])
        (if (>= lo hi)
            lo
            (let ([mid (quotient (+ lo hi 1) 2)])
              (if (<= (vector-ref v mid) pos)
                  (loop mid hi)
                  (loop lo (- mid 1))))))))

  (define (text-column t pos) (- pos (text-line-start t (text-line-of t pos))))

  ;; The position at `col` characters into `line`, clamped to the line.
  (define (text-pos-at t line col)
    (let ([s (text-line-start t line)] [e (text-line-end t line)])
      (min e (+ s (max 0 col)))))

  (define (match-at? t i needle)
    (let ([m (string-length needle)])
      (and (<= (+ i m) (text-length t))
           (let loop ([j 0])
             (or (= j m)
                 (and (char=? (text-ref t (+ i j)) (string-ref needle j))
                      (loop (+ j 1))))))))

  (define (text-search-forward t needle pos)
    (let ([n (text-length t)])
      (and (> (string-length needle) 0)
           (let loop ([i pos])
             (cond [(> (+ i (string-length needle)) n) #f]
                   [(match-at? t i needle) i]
                   [else (loop (+ i 1))])))))

  (define (text-search-backward t needle pos)
    (and (> (string-length needle) 0)
         (let loop ([i (min pos (- (text-length t) (string-length needle)))])
           (cond [(< i 0) #f]
                 [(match-at? t i needle) i]
                 [else (loop (- i 1))])))))
