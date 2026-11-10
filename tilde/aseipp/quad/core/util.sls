;; util.sls -- small helpers shared by the rest of quad
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad util)
  (export at-load ignore condition->string clamp string-prefix? string-suffix? string-index string-contains
          string-splice string-first-line string-clip
          string-join string-split string-trim-left string-trim-right string-trim
          char-width string-width grapheme-end grapheme-start grapheme-columns
          string-graphemes string-grapheme-before string-grapheme-after fuzzy-score
          list-index take drop filter-map
          bytevector-append bytevector->hex percent-decode
          path-join path-basename path-dirname ancestor-dirs expand-home absolute-path
          make-directories! find-executable
          sort-strings sort-symbols macos?)
  (import (chezscheme))

  ;; Chez Scheme allows no definitions after an expression in a library
  ;; body, so expressions run for effect at load time are written as
  ;; (at-load expr ...), a definition of a fresh, unused variable.
  (define-syntax at-load
    (syntax-rules ()
      [(_ e ...) (define ignored (begin e ... #f))]))

  ;; Takes anything and does nothing: a callback for what is not needed.
  ;; (Chez Scheme's void takes nothing.)
  (define (ignore . _) (void))

  ;; What went wrong, as a message: a condition as Chez Scheme displays
  ;; it, anything else raised as display shows it.
  (define (condition->string e)
    (if (condition? e)
        (call-with-string-output-port (lambda (p) (display-condition e p)))
        (format "~a" e)))

  (define (clamp x lo hi) (max lo (min hi x)))

  ;; Whether s has p's characters from `at` on.
  (define (string-at? p s at)
    (let ([n (string-length p)])
      (and (<= 0 at) (<= (+ at n) (string-length s))
           (let loop ([i 0])
             (or (= i n)
                 (and (char=? (string-ref p i) (string-ref s (+ at i))) (loop (+ i 1))))))))

  (define (string-prefix? p s) (string-at? p s 0))

  ;; s up to its first newline.
  (define (string-first-line s)
    (let ([i (string-index s #\newline)]) (if i (substring s 0 i) s)))

  ;; s, at most n characters: past that, its first n - 1 and an ellipsis.
  (define (string-clip s n)
    (if (> (string-length s) n) (string-append (substring s 0 (- n 1)) "…") s))

  ;; s with its characters from start to end replaced by new.
  (define (string-splice s start end new)
    (string-append (substring s 0 start) new (substring s end (string-length s))))

  (define (string-suffix? p s) (string-at? p s (- (string-length s) (string-length p))))

  ;; Whether this is macOS: Chez Scheme's machine types for it end so
  ;; (tarm64osx, ta6osx).
  (define macos? (string-suffix? "osx" (symbol->string (machine-type))))

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


  ;; Terminal columns a character occupies: 0 for combining marks and other
  ;; zero-width code points, 2 for East Asian wide and most emoji, else 1.
  (define (char-width c)
    (let ([n (char->integer c)])
      (cond
       [(< n #x300) 1]
       [(or (<= #x300 n #x36F) (<= #x200B n #x200F) (<= #xFE00 n #xFE0F)
            (<= #x20D0 n #x20FF) (<= #xFE20 n #xFE2F) (<= #x1160 n #x11FF)
            (<= #xE0020 n #xE007F) (<= #xE0100 n #xE01EF))
        0]
       [(or (<= #x1100 n #x115F) (<= #x2E80 n #x303E) (<= #x3041 n #x33FF)
            (<= #x3400 n #x4DBF) (<= #x4E00 n #x9FFF) (<= #xA000 n #xA4CF)
            (<= #xAC00 n #xD7A3) (<= #xF900 n #xFAFF) (<= #xFE30 n #xFE4F)
            (<= #xFF00 n #xFF60) (<= #xFFE0 n #xFFE6)
            (<= #x1F300 n #x1F64F) (<= #x1F900 n #x1F9FF)
            (<= #x1F680 n #x1F6FF) (<= #x1FA70 n #x1FAFF) (<= #x1F200 n #x1F2FF)
            (<= #x20000 n #x3FFFD))
        2]
       [(and (or (<= #x2300 n #x2BFF) (<= #x1F000 n #x1F7FF)) (wide-emoji? n)) 2]
       [else 1])))

  ;; Emoji shown as pictures unless asked otherwise (Unicode's
  ;; Emoji_Presentation), outside the blocks above: terminals give them two
  ;; columns, as East Asian wide characters.
  (define wide-emoji
    '((#x231A . #x231B) (#x23E9 . #x23EC) (#x23F0 . #x23F0) (#x23F3 . #x23F3)
      (#x25FD . #x25FE) (#x2614 . #x2615) (#x2648 . #x2653) (#x267F . #x267F)
      (#x2693 . #x2693) (#x26A1 . #x26A1) (#x26AA . #x26AB) (#x26BD . #x26BE)
      (#x26C4 . #x26C5) (#x26CE . #x26CE) (#x26D4 . #x26D4) (#x26EA . #x26EA)
      (#x26F2 . #x26F3) (#x26F5 . #x26F5) (#x26FA . #x26FA) (#x26FD . #x26FD)
      (#x2705 . #x2705) (#x270A . #x270B) (#x2728 . #x2728) (#x274C . #x274C)
      (#x274E . #x274E) (#x2753 . #x2755) (#x2757 . #x2757) (#x2795 . #x2797)
      (#x27B0 . #x27B0) (#x27BF . #x27BF) (#x2B1B . #x2B1C) (#x2B50 . #x2B50)
      (#x2B55 . #x2B55) (#x1F004 . #x1F004) (#x1F0CF . #x1F0CF) (#x1F18E . #x1F18E)
      (#x1F191 . #x1F19A) (#x1F7E0 . #x1F7EB) (#x1F7F0 . #x1F7F0)))

  (define (wide-emoji? n)
    (exists (lambda (r) (<= (car r) n (cdr r))) wide-emoji))

  ;; ---------------------------------------------------------------------------
  ;; Grapheme clusters: what shows in one place, as one character. The
  ;; editor draws, counts columns, moves and deletes by them, as terminals
  ;; that cluster graphemes (mode 2027: kitty, ghostty, wezterm, foot) draw
  ;; them: a character with the marks, variation selectors, joiners and tags
  ;; after it; an emoji with its skin tone, and those a zero-width joiner
  ;; joins to it (a family, 👨‍👩‍👧); two regional indicators, a flag (🇯🇵).
  ;; Each takes its first character's columns, but two for an emoji asked
  ;; for as a picture (U+FE0F) and for a flag. Clusters are over characters
  ;; (ref i) for indexes up to an end, so that strings and buffer texts
  ;; alike have them; a newline is always a cluster of its own.

  (define (regional-indicator? c) (<= #x1F1E6 (char->integer c) #x1F1FF))

  ;; Whether c continues the cluster whose last character is prev and
  ;; which has `ri` regional indicators.
  (define (extends? prev c ri)
    (let ([n (char->integer c)] [p (char->integer prev)])
      (cond
       [(or (char=? c #\newline) (char=? prev #\newline) (char=? c #\tab)) #f]
       [(= (char-width c) 0) #t]
       ;; After a zero-width joiner, what it joins.
       [(= p #x200D) (> n #x7F)]
       ;; Skin tones, after an emoji.
       [(<= #x1F3FB n #x1F3FF) (> p #x7F)]
       [(regional-indicator? c) (odd? ri)]
       [else #f])))

  ;; The end of the cluster that starts at i, of the characters (ref k)
  ;; for k below end.
  (define (grapheme-end ref i end)
    (if (>= i end)
        i
        (let loop ([j (+ i 1)] [prev (ref i)] [ri (if (regional-indicator? (ref i)) 1 0)])
          (if (>= j end)
              j
              (let ([c (ref j)])
                (if (extends? prev c ri)
                    (loop (+ j 1) c (if (regional-indicator? c) (+ ri 1) ri))
                    j))))))

  ;; The start of the cluster that index i is in, finding clusters from
  ;; the last ASCII character at or before i (a newline, at the furthest):
  ;; one never continues a cluster (extends?), so one begins there.
  (define (grapheme-start ref i)
    (let loop ([c (let back ([k i])
                    (cond [(<= k 0) 0]
                          [(< (char->integer (ref k)) #x80) k]
                          [else (back (- k 1))]))])
      (let ([e (grapheme-end ref c (+ i 1))])
        (if (or (> e i) (= e c)) c (loop e)))))

  ;; The columns the cluster [i, j) takes.
  (define (grapheme-columns ref i j)
    (let ([first (ref i)])
      (let ([w (char-width first)])
        (cond
         [(= w 0) 0]
         [(and (regional-indicator? first) (> (- j i) 1)) 2]
         [(and (= w 1) (let loop ([k (+ i 1)])
                         (and (< k j) (or (char=? (ref k) #\xFE0F) (loop (+ k 1))))))
          2]
         [else w]))))

  ;; The clusters of s, as strings.
  (define (string-graphemes s)
    (let ([ref (lambda (i) (string-ref s i))] [n (string-length s)])
      (let loop ([i 0] [acc '()])
        (if (>= i n)
            (reverse acc)
            (let ([j (grapheme-end ref i n)])
              (loop j (cons (substring s i j) acc)))))))

  ;; Where the cluster before or after index c of string s starts or ends.
  (define (string-grapheme-before s c)
    (if (<= c 0) 0 (grapheme-start (lambda (i) (string-ref s i)) (- c 1))))
  (define (string-grapheme-after s c)
    (grapheme-end (lambda (i) (string-ref s i)) c (string-length s)))

  (define (string-width s)
    (let ([ref (lambda (i) (string-ref s i))] [n (string-length s)])
      (let loop ([i 0] [w 0])
        (if (>= i n)
            w
            (let ([j (grapheme-end ref i n)])
              (loop j (+ w (grapheme-columns ref i j))))))))

  ;; The bytevectors bvs, one after another, in one.
  (define (bytevector-append . bvs)
    (let-values ([(out extract) (open-bytevector-output-port)])
      (for-each (lambda (bv) (put-bytevector out bv)) bvs)
      (extract)))

  (define (hex-digit c) (string->number (string c) 16))

  ;; %XX escapes decoded, as UTF-8.
  (define (percent-decode s)
    (let ([n (string-length s)])
      (if (not (string-index s #\%))
          s
          (let-values ([(out extract) (open-bytevector-output-port)])
            (let loop ([i 0])
              (when (< i n)
                (let ([c (string-ref s i)])
                  (if (and (char=? c #\%) (< (+ i 2) n)
                           (hex-digit (string-ref s (+ i 1))) (hex-digit (string-ref s (+ i 2))))
                      (begin (put-u8 out (+ (* 16 (hex-digit (string-ref s (+ i 1)))) (hex-digit (string-ref s (+ i 2)))))
                             (loop (+ i 3)))
                      (begin (put-bytevector out (string->utf8 (string c))) (loop (+ i 1)))))))
            (utf8->string (extract))))))

  ;; bv's bytes in lowercase hex, two digits each.
  (define (bytevector->hex bv)
    (string-downcase
     (apply string-append
            (map (lambda (b) (string-append (if (< b 16) "0" "") (number->string b 16)))
                 (bytevector->u8-list bv)))))

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

  (define (filter-map f l)
    (let loop ([l l])
      (if (null? l)
          '()
          (let ([v (f (car l))]) (if v (cons v (loop (cdr l))) (loop (cdr l)))))))

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

  ;; dir, then the directories it is in, out to the last.
  (define (ancestor-dirs dir)
    (let loop ([d dir] [acc '()])
      (let ([up (path-dirname d)])
        (if (string=? up d) (reverse (cons d acc)) (loop up (cons d acc))))))

  (define (expand-home p)
    (if (and (string-prefix? "~/" p) (getenv "HOME"))
        (path-join (getenv "HOME") (substring p 2 (string-length p)))
        p))

  ;; p, from the current directory if it is relative.
  (define (absolute-path p)
    (if (string-prefix? "/" p) p (path-join (current-directory) p)))

  ;; Makes directory dir, and those it is in, unless they exist.
  (define (make-directories! dir)
    (unless (or (string=? dir "") (file-exists? dir))
      (make-directories! (path-dirname dir))
      (mkdir dir)))

  ;; Where program is: itself, if it names a directory, else the first
  ;; file of that name in a directory of PATH; or #f.
  (define (find-executable program)
    (if (string-index program #\/)
        (and (file-exists? program) program)
        (exists (lambda (dir)
                  (let ([f (path-join (if (string=? dir "") "." dir) program)])
                    (and (file-exists? f) (not (file-directory? f)) f)))
                (string-split (or (getenv "PATH") "") #\:))))

  (define (sort-strings l) (sort string<? l))
  (define (sort-symbols l) (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) l)))
