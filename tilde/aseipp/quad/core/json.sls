;; json.sls -- JSON, read and written
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; JSON values as Scheme values, as SRFI 180 has them: objects are
;; association lists with symbol keys, arrays are vectors, null is the
;; symbol null, and true and false are #t and #f. Since arrays are vectors,
;; '() is the empty object. Integers read exact, other numbers inexact.
;;
;;   (json-read-string "{\"a\": [1, 2.5, null]}")   ⇒ ((a . #(1 2.5 null)))
;;   (json->string '((ok . #t) (items . #())))      ⇒ "{\"ok\":true,\"items\":[]}"
(library (quad json)
  (export json-read json-read-string json-write json->string json-ref json-object?)
  (import (chezscheme))

  ;; ---------------------------------------------------------------------------
  ;; Reading

  (define (json-error p msg . args)
    (raise (condition (make-error) (make-who-condition 'json-read)
                      (make-message-condition (string-append "JSON: " msg " at character ~a"))
                      (make-irritants-condition (append args (list (port-position p)))))))

  (define (skip-space p)
    (let ([c (peek-char p)])
      (when (and (char? c) (memv c '(#\space #\tab #\newline #\return)))
        (read-char p)
        (skip-space p))))

  (define (expect p want)
    (let ([c (read-char p)])
      (unless (eqv? c want) (json-error p "expected ~s, found ~s" want c))))

  (define (expect-word p word value)
    (string-for-each (lambda (c) (expect p c)) word)
    value)

  ;; The next JSON value from port p; the end of file if there is none.
  (define (json-read p)
    (skip-space p)
    (let ([c (peek-char p)])
      (cond
       [(eof-object? c) c]
       [(char=? c #\{) (read-char p) (read-object p)]
       [(char=? c #\[) (read-char p) (read-array p)]
       [(char=? c #\") (read-char p) (read-string-body p)]
       [(char=? c #\t) (expect-word p "true" #t)]
       [(char=? c #\f) (expect-word p "false" #f)]
       [(char=? c #\n) (expect-word p "null" 'null)]
       [(or (char=? c #\-) (char-numeric? c)) (read-number p)]
       [else (json-error p "unexpected ~s" c)])))

  (define (read-value p)
    (let ([v (json-read p)])
      (when (eof-object? v) (json-error p "unexpected end"))
      v))

  (define (read-object p)
    (skip-space p)
    (if (eqv? (peek-char p) #\})
        (begin (read-char p) '())
        (let loop ([acc '()])
          (skip-space p)
          (expect p #\")
          (let ([key (string->symbol (read-string-body p))])
            (skip-space p)
            (expect p #\:)
            (let ([acc (cons (cons key (read-value p)) acc)])
              (skip-space p)
              (let ([c (read-char p)])
                (cond
                 [(eqv? c #\,) (loop acc)]
                 [(eqv? c #\}) (reverse acc)]
                 [else (json-error p "expected , or } in an object, found ~s" c)])))))))

  (define (read-array p)
    (skip-space p)
    (if (eqv? (peek-char p) #\])
        (begin (read-char p) (vector))
        (let loop ([acc '()])
          (let ([acc (cons (read-value p) acc)])
            (skip-space p)
            (let ([c (read-char p)])
              (cond
               [(eqv? c #\,) (loop acc)]
               [(eqv? c #\]) (list->vector (reverse acc))]
               [else (json-error p "expected , or ] in an array, found ~s" c)]))))))

  (define (read-hex4 p)
    (let loop ([i 0] [n 0])
      (if (= i 4)
          n
          (let* ([c (read-char p)] [d (and (char? c) (string->number (string c) 16))])
            (unless d (json-error p "bad \\u escape"))
            (loop (+ i 1) (+ (* n 16) d))))))

  ;; After the opening quote.
  (define (read-string-body p)
    (let-values ([(out done) (open-string-output-port)])
      (let loop ()
        (let ([c (read-char p)])
          (cond
           [(eof-object? c) (json-error p "unterminated string")]
           [(char=? c #\") (done)]
           [(char=? c #\\)
            (let ([e (read-char p)])
              (case e
                [(#\" #\\ #\/) (write-char e out)]
                [(#\b) (write-char #\backspace out)]
                [(#\f) (write-char #\page out)]
                [(#\n) (write-char #\newline out)]
                [(#\r) (write-char #\return out)]
                [(#\t) (write-char #\tab out)]
                [(#\u)
                 (let ([u (read-hex4 p)])
                   (cond
                    ;; A surrogate pair: a character beyond the BMP.
                    [(and (<= #xD800 u #xDBFF) (eqv? (peek-char p) #\\))
                     (read-char p)
                     (expect p #\u)
                     (let ([lo (read-hex4 p)])
                       (if (<= #xDC00 lo #xDFFF)
                           (write-char (integer->char (+ #x10000 (* (- u #xD800) #x400) (- lo #xDC00))) out)
                           (json-error p "bad surrogate pair")))]
                    [(<= #xD800 u #xDFFF) (write-char #\xFFFD out)]
                    [else (write-char (integer->char u) out)]))]
                [else (json-error p "bad escape \\~a" e)]))
            (loop)]
           [else (write-char c out) (loop)])))))

  (define (read-number p)
    (let-values ([(out done) (open-string-output-port)])
      (let loop ()
        (let ([c (peek-char p)])
          (when (and (char? c) (or (char-numeric? c) (memv c '(#\- #\+ #\. #\e #\E))))
            (write-char (read-char p) out)
            (loop))))
      (let* ([s (done)]
             [n (string->number s)])
        (unless n (json-error p "bad number ~s" s))
        (if (and (exact? n) (not (integer? n))) (inexact n) n))))

  ;; The JSON value in string s, which must hold exactly one.
  (define (json-read-string s)
    (let* ([p (open-input-string s)] [v (read-value p)])
      (skip-space p)
      (unless (eof-object? (peek-char p)) (json-error p "trailing characters"))
      v))

  ;; ---------------------------------------------------------------------------
  ;; Writing

  (define (json-object? v)
    (or (null? v) (and (pair? v) (pair? (car v)) (symbol? (caar v)))))

  (define (write-string-literal s p)
    (write-char #\" p)
    (string-for-each
     (lambda (c)
       (case c
         [(#\") (put-string p "\\\"")]
         [(#\\) (put-string p "\\\\")]
         [(#\newline) (put-string p "\\n")]
         [(#\return) (put-string p "\\r")]
         [(#\tab) (put-string p "\\t")]
         [else
          (if (< (char->integer c) #x20)
              (put-string p (string-append "\\u00" (if (< (char->integer c) 16) "0" "")
                                           (number->string (char->integer c) 16)))
              (write-char c p))]))
     s)
    (write-char #\" p))

  ;; Write value v to port p as JSON. Strings and symbols (other than null)
  ;; are strings; lists that are not objects are arrays, as vectors are.
  (define (json-write v p)
    (cond
     [(eq? v #t) (put-string p "true")]
     [(eq? v #f) (put-string p "false")]
     [(eq? v 'null) (put-string p "null")]
     [(string? v) (write-string-literal v p)]
     [(symbol? v) (write-string-literal (symbol->string v) p)]
     [(and (integer? v) (exact? v)) (put-string p (number->string v))]
     [(real? v)
      (unless (and (finite? v) (not (nan? v))) (errorf 'json-write "~s has no JSON form" v))
      (if (integer? v)
          (put-string p (number->string (exact v)))
          (put-string p (number->string (inexact v))))]
     [(vector? v) (write-sequence (vector->list v) p)]
     [(json-object? v)
      (write-char #\{ p)
      (let loop ([l v] [first? #t])
        (unless (null? l)
          (unless first? (write-char #\, p))
          (write-string-literal (symbol->string (caar l)) p)
          (write-char #\: p)
          (json-write (cdar l) p)
          (loop (cdr l) #f)))
      (write-char #\} p)]
     [(list? v) (write-sequence v p)]
     [else (errorf 'json-write "~s has no JSON form" v)]))

  (define (write-sequence l p)
    (write-char #\[ p)
    (let loop ([l l] [first? #t])
      (unless (null? l)
        (unless first? (write-char #\, p))
        (json-write (car l) p)
        (loop (cdr l) #f)))
    (write-char #\] p))

  (define (json->string v)
    (call-with-string-output-port (lambda (p) (json-write v p))))

  ;; Follow a path of keys (symbols, into objects) and indices (into
  ;; arrays) from v: the value there, or #f if there is none. A null on the
  ;; way, or at the end, is none too.
  (define (json-ref v . path)
    (let loop ([v v] [path path])
      (cond
       [(eq? v 'null) #f]
       [(null? path) v]
       [(and (symbol? (car path)) (json-object? v))
        (let ([e (assq (car path) v)])
          (and e (loop (cdr e) (cdr path))))]
       [(and (fixnum? (car path)) (vector? v) (< -1 (car path) (vector-length v)))
        (loop (vector-ref v (car path)) (cdr path))]
       [else #f]))))
