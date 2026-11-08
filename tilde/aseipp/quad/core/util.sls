;; util.sls -- small helpers shared by the rest of quad
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad util)
  (export at-load clamp string-prefix? string-suffix? string-index string-contains
          string-join string-split string-trim-left string-trim-right string-trim
          string-repeat string-upcase* string-downcase*
          char-width string-width fuzzy-score
          list-index take drop last-pair* filter-map delete-duplicates*
          path-join path-basename path-dirname expand-home
          sort-strings)
  (import (chezscheme))

  ;; Chez Scheme allows no definitions after an expression in a library
  ;; body, so expressions run for effect at load time are written as
  ;; (at-load expr ...), a definition of a fresh, unused variable.
  (define-syntax at-load
    (syntax-rules ()
      [(_ e ...) (define ignored (begin e ... #f))]))

  (define (clamp x lo hi) (max lo (min hi x)))

  (define (string-prefix? p s)
    (let ([n (string-length p)])
      (and (<= n (string-length s)) (string=? p (substring s 0 n)))))

  (define (string-suffix? p s)
    (let ([n (string-length p)] [m (string-length s)])
      (and (<= n m) (string=? p (substring s (- m n) m)))))

  (define string-index
    (case-lambda
     [(s pred) (string-index s pred 0)]
     [(s pred start)
      (let ([n (string-length s)]
            [ok? (if (char? pred) (lambda (c) (char=? c pred)) pred)])
        (let loop ([i start])
          (cond [(>= i n) #f] [(ok? (string-ref s i)) i] [else (loop (+ i 1))])))]))

  ;; The index of the first occurrence of `needle` in `s` at or after
  ;; `start`, or #f.
  (define string-contains
    (case-lambda
     [(s needle) (string-contains s needle 0)]
     [(s needle start)
      (let ([n (string-length s)] [m (string-length needle)])
        (let loop ([i start])
          (cond
           [(> (+ i m) n) #f]
           [(let cmp ([j 0])
              (or (= j m)
                  (and (char=? (string-ref s (+ i j)) (string-ref needle j))
                       (cmp (+ j 1)))))
            i]
           [else (loop (+ i 1))])))]))

  (define (string-join strs sep)
    (if (null? strs)
        ""
        (apply string-append
               (car strs)
               (let loop ([l (cdr strs)])
                 (if (null? l) '() (cons sep (cons (car l) (loop (cdr l)))))))))

  (define (string-split s ch)
    (let ([n (string-length s)])
      (let loop ([i 0] [start 0] [acc '()])
        (cond
         [(= i n) (reverse (cons (substring s start n) acc))]
         [(char=? (string-ref s i) ch)
          (loop (+ i 1) (+ i 1) (cons (substring s start i) acc))]
         [else (loop (+ i 1) start acc)]))))

  (define (string-trim-left s)
    (let ([n (string-length s)])
      (let loop ([i 0])
        (if (and (< i n) (char-whitespace? (string-ref s i)))
            (loop (+ i 1))
            (substring s i n)))))

  (define (string-trim-right s)
    (let loop ([i (string-length s)])
      (if (and (> i 0) (char-whitespace? (string-ref s (- i 1))))
          (loop (- i 1))
          (substring s 0 i))))

  (define (string-trim s) (string-trim-left (string-trim-right s)))

  (define (string-repeat s n)
    (let loop ([n n] [acc '()])
      (if (<= n 0) (apply string-append acc) (loop (- n 1) (cons s acc)))))

  (define (string-upcase* s) (string-upcase s))
  (define (string-downcase* s) (string-downcase s))

  ;; Terminal columns a character occupies: 0 for combining marks and other
  ;; zero-width code points, 2 for East Asian wide and most emoji, else 1.
  (define (char-width c)
    (let ([n (char->integer c)])
      (cond
       [(< n #x300) 1]
       [(or (<= #x300 n #x36F) (<= #x200B n #x200F) (= n #xFE0F)
            (<= #x20D0 n #x20FF) (<= #xFE20 n #xFE2F))
        0]
       [(or (<= #x1100 n #x115F) (<= #x2E80 n #x303E) (<= #x3041 n #x33FF)
            (<= #x3400 n #x4DBF) (<= #x4E00 n #x9FFF) (<= #xA000 n #xA4CF)
            (<= #xAC00 n #xD7A3) (<= #xF900 n #xFAFF) (<= #xFE30 n #xFE4F)
            (<= #xFF00 n #xFF60) (<= #xFFE0 n #xFFE6)
            (<= #x1F300 n #x1F64F) (<= #x1F900 n #x1F9FF)
            (<= #x1F680 n #x1F6FF) (<= #x20000 n #x3FFFD))
        2]
       [else 1])))

  (define (string-width s)
    (let loop ([i 0] [w 0])
      (if (= i (string-length s)) w (loop (+ i 1) (+ w (char-width (string-ref s i)))))))

  ;; Score `candidate` against `pattern` as a case-insensitive subsequence
  ;; match: #f if it does not match, else (score . matched-indices) where a
  ;; higher score is better. Consecutive matches and matches at word starts
  ;; score higher; shorter candidates win ties.
  (define (fuzzy-score pattern candidate)
    (let ([pn (string-length pattern)] [cn (string-length candidate)])
      (let loop ([pi 0] [ci 0] [score 0] [prev -2] [hits '()])
        (cond
         [(= pi pn) (cons (- score (* cn 0.01)) (reverse hits))]
         [(= ci cn) #f]
         [(char-ci=? (string-ref pattern pi) (string-ref candidate ci))
          (let* ([boundary? (or (= ci 0)
                                (memv (string-ref candidate (- ci 1)) '(#\/ #\- #\_ #\. #\space)))]
                 [bonus (+ 1 (if (= prev (- ci 1)) 5 0) (if boundary? 3 0))])
            (loop (+ pi 1) (+ ci 1) (+ score bonus) ci (cons ci hits)))]
         [else (loop pi (+ ci 1) score prev hits)]))))

  (define (list-index pred l)
    (let loop ([l l] [i 0])
      (cond [(null? l) #f] [(pred (car l)) i] [else (loop (cdr l) (+ i 1))])))

  (define (take l n) (if (or (= n 0) (null? l)) '() (cons (car l) (take (cdr l) (- n 1)))))
  (define (drop l n) (if (or (= n 0) (null? l)) l (drop (cdr l) (- n 1))))
  (define (last-pair* l) (if (null? (cdr l)) l (last-pair* (cdr l))))

  (define (filter-map f l)
    (let loop ([l l])
      (if (null? l)
          '()
          (let ([v (f (car l))]) (if v (cons v (loop (cdr l))) (loop (cdr l)))))))

  (define (delete-duplicates* l same?)
    (let loop ([l l] [acc '()])
      (cond
       [(null? l) (reverse acc)]
       [(exists (lambda (x) (same? x (car l))) acc) (loop (cdr l) acc)]
       [else (loop (cdr l) (cons (car l) acc))])))

  (define (path-join a b)
    (cond
     [(string=? a "") b]
     [(string-suffix? "/" a) (string-append a b)]
     [else (string-append a "/" b)]))

  (define (path-basename p)
    (let loop ([i (string-length p)])
      (cond [(= i 0) p]
            [(char=? (string-ref p (- i 1)) #\/) (substring p i (string-length p))]
            [else (loop (- i 1))])))

  (define (path-dirname p)
    (let loop ([i (string-length p)])
      (cond [(= i 0) "."]
            [(char=? (string-ref p (- i 1)) #\/) (if (= i 1) "/" (substring p 0 (- i 1)))]
            [else (loop (- i 1))])))

  (define (expand-home p)
    (if (and (string-prefix? "~/" p) (getenv "HOME"))
        (path-join (getenv "HOME") (substring p 2 (string-length p)))
        p))

  (define (sort-strings l) (sort string<? l)))
