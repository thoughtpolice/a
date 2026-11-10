;; selection.sls -- selection modes and their movements
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad edits the way Ki does: a selection mode decides what the units of the
;; text are (characters, subwords, words, lines, syntax nodes, search
;; matches...), and one set of movements works on all of them:
;;
;;   left/right    previous/next unit, skipping minor ones (symbols, for words)
;;   previous/next previous/next unit of any kind (blank lines, in line mode)
;;   up/down       the nearest unit above/below (parent/child, for nodes)
;;   first/last    the first/last unit in the enclosing scope
;;
;; Movements take and return ranges, (start . end) pairs.
(library (quad selection)
  (export make-selection-mode selection-mode? selection-mode-name selection-mode-label
          selection-mode-current selection-mode-move selection-mode-visible
          selection-mode-line-wise? selection-mode-of-text?
          define-selection-mode! find-selection-mode selection-mode-names
          token-units line-range line-full-range blank-line? line-indent-end blanks-before
          search-pattern search-pattern-set! search-error search-matches search-from goal-column)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (only (quad native) search-new search-next search-prev search-all))

  (define-record-type selection-mode
    (fields name
            label
            current      ; (buffer range) -> range or #f
            move         ; (buffer range direction) -> range or #f
            visible      ; (buffer first-line last-line) -> ranges, for jumps
            line-wise?   ; units are lines: gaps are newlines
            of-text?)    ; units are the text's own, not things found in it
                         ; (search matches, diagnostics): typing leaves them
    (protocol
     (lambda (new)
       (case-lambda
        [(name label current move visible line-wise?)
         (new name label current move visible line-wise? #t)]
        [(name label current move visible line-wise? of-text?)
         (new name label current move visible line-wise? of-text?)]))))

  ;; The column vertical movements aim for, kept across a run of them by the
  ;; view (its sticky column); #f aims for the selection's own column.
  (define goal-column (make-parameter #f))

  (define registry (make-eq-hashtable))
  (define (define-selection-mode! m) (hashtable-set! registry (selection-mode-name m) m))
  (define (find-selection-mode name)
    (or (hashtable-ref registry name #f) (errorf 'selection-mode "unknown selection mode ~s" name)))
  (define (selection-mode-names) (vector->list (hashtable-keys registry)))

  (define (syntax-of b) (major-mode-syntax (buffer-major-mode b)))
  (define (word-char b) (syntax-word-char? (syntax-of b)))

  ;; ---------------------------------------------------------------------------
  ;; Lines

  (define (blank-line? t line)
    (let ([s (text-line-start t line)] [e (text-line-end t line)])
      (let loop ([i s]) (or (= i e) (and (char-whitespace? (text-ref t i)) (loop (+ i 1)))))))

  (define (line-indent-end t line)
    (let ([e (text-line-end t line)])
      (let loop ([i (text-line-start t line)])
        (if (and (< i e) (memv (text-ref t i) '(#\space #\tab))) (loop (+ i 1)) i))))

  ;; Where the spaces and tabs before p in t start, back to no earlier
  ;; than line-start.
  (define (blanks-before t p line-start)
    (let loop ([i p])
      (if (and (> i line-start) (memv (text-ref t (- i 1)) '(#\space #\tab))) (loop (- i 1)) i)))

  ;; A line without its indentation and trailing whitespace.
  (define (line-range t line)
    (let* ([s (line-indent-end t line)]
           [e (let loop ([i (text-line-end t line)])
                (if (and (> i s) (char-whitespace? (text-ref t (- i 1)))) (loop (- i 1)) i))])
      (cons s e)))

  ;; A whole line, its newline included.
  (define (line-full-range t line)
    (cons (text-line-start t line)
          (min (text-length t) (+ 1 (text-line-end t line)))))

  (define (lines-mode name label range-of)
    (define (line-of b r) (text-line-of (buffer-text b) (car r)))
    (define (last-line b) (- (text-line-count (buffer-text b)) 1))
    (make-selection-mode
     name label
     (lambda (b r) (range-of (buffer-text b) (line-of b r)))
     (lambda (b r dir)
       (let* ([t (buffer-text b)] [l (line-of b r)] [n (last-line b)])
         (define (at line) (and (<= 0 line n) (range-of t line)))
         (define (blank-from line step)
           (let loop ([line (+ line step)])
             (cond [(not (<= 0 line n)) #f]
                   [(blank-line? t line) (at line)]
                   [else (loop (+ line step))])))
         (case dir
           [(left up) (at (- l 1))]
           [(right down) (at (+ l 1))]
           [(previous) (blank-from l -1)]
           [(next) (blank-from l 1)]
           [(first) (at 0)]
           [(last) (at (if (and (> n 0) (= (text-line-start t n) (text-length t))) (- n 1) n))]
           [else #f])))
     (lambda (b first last)
       (let loop ([l last] [acc '()])
         (if (< l first) acc (loop (- l 1) (cons (range-of (buffer-text b) l) acc)))))
     #t))

  ;; ---------------------------------------------------------------------------
  ;; Tokens: characters, subwords, words and WORDs
  ;;
  ;; (token-units kind buffer line) lists the units on a line, in order, as
  ;; (start end major?).

  ;; A line's characters, each a grapheme cluster, and its newline.
  (define (char-units t line)
    (let* ([s (text-line-start t line)] [e (text-line-end t line)]
           [end (min (+ e 1) (text-length t))] [ref (lambda (i) (text-ref t i))])
      (if (and (= s end) (= s (text-length t)))
          (list (list s s #t))
          (let loop ([i s] [acc '()])
            (if (>= i end)
                (reverse acc)
                (let ([j (if (= i e) (+ i 1) (grapheme-end ref i e))])
                  (loop j (cons (list i j #t) acc))))))))

  (define (runs t s e classify)
    ;; Split [s, e) into maximal runs of the same class; class #f is skipped,
    ;; and class 'each makes every character its own run.
    (let loop ([i s] [acc '()])
      (if (>= i e)
          (reverse acc)
          (let ([k (classify (text-ref t i))])
            (cond
             [(not k) (loop (+ i 1) acc)]
             [(eq? k 'each) (loop (+ i 1) (cons (list i (+ i 1) #f) acc))]
             [else
              (let run ([j (+ i 1)])
                (if (and (< j e) (eq? (classify (text-ref t j)) k))
                    (run (+ j 1))
                    (loop j (cons (list i j (not (eq? k 'minor))) acc))))])))))

  (define (word-units b t line)
    (let ([w? (word-char b)])
      (runs t (text-line-start t line) (text-line-end t line)
            (lambda (c) (cond [(char-whitespace? c) #f] [(w? c) 'word] [else 'each])))))

  (define (big-word-units t line)
    (runs t (text-line-start t line) (text-line-end t line)
          (lambda (c) (if (char-whitespace? c) #f 'word))))

  ;; Subwords split words at case changes, underscores, hyphens and digits:
  ;; fooBarBAZ_qux-9 is foo Bar BAZ qux 9.
  (define (subword-units b t line)
    (let ([w? (word-char b)] [e (text-line-end t line)])
      (let loop ([i (text-line-start t line)] [acc '()])
        (if (>= i e)
            (reverse acc)
            (let ([c (text-ref t i)])
              (cond
               [(char-whitespace? c) (loop (+ i 1) acc)]
               [(or (not (w? c)) (memv c '(#\_ #\-)))
                (loop (+ i 1) (cons (list i (+ i 1) #f) acc))]
               [(char-numeric? c)
                (let run ([j (+ i 1)])
                  (if (and (< j e) (char-numeric? (text-ref t j))) (run (+ j 1))
                      (loop j (cons (list i j #t) acc))))]
               [(char-upper-case? c)
                (let ([j (let run ([j (+ i 1)])
                           (if (and (< j e) (char-upper-case? (text-ref t j))) (run (+ j 1)) j))])
                  (cond
                   [(and (< j e) (char-lower-case? (text-ref t j)))
                    ;; "HTTPServer": HTTP then Server.
                    (let ([start (if (> (- j i) 1) (- j 1) i)])
                      (let run ([k j])
                        (if (and (< k e) (char-lower-case? (text-ref t k))) (run (+ k 1))
                            (loop k (cons (list start k #t)
                                          (if (> start i) (cons (list i start #t) acc) acc))))))]
                   [else (loop j (cons (list i j #t) acc))]))]
               [(w? c)
                (let run ([j (+ i 1)])
                  (if (and (< j e) (let ([d (text-ref t j)])
                                     (and (w? d) (not (char-upper-case? d)) (not (char-numeric? d))
                                          (not (memv d '(#\_ #\-))))))
                      (run (+ j 1))
                      (loop j (cons (list i j #t) acc))))]
               [else (loop (+ i 1) acc)]))))))

  (define (token-units kind b line)
    (let ([t (buffer-text b)])
      (case kind
        [(char) (char-units t line)]
        [(subword) (subword-units b t line)]
        [(word) (word-units b t line)]
        [(big-word) (big-word-units t line)])))

  (define (tokens-mode name label kind)
    (define (units b line) (token-units kind b line))
    (define (line-count b) (text-line-count (buffer-text b)))
    (define (col b pos) (text-column (buffer-text b) pos))

    ;; The first unit after (dir 1) or before (dir -1) position `pos`,
    ;; searching outward line by line; major-only skips minor units.
    (define (scan b pos dir major-only?)
      (let* ([t (buffer-text b)] [n (line-count b)])
        (let loop ([line (text-line-of t pos)])
          (and (<= 0 line (- n 1))
               (let* ([ok? (lambda (u) (or (not major-only?) (caddr u)))]
                      [us (units b line)]
                      [hit (if (> dir 0)
                               (find (lambda (u) (and (ok? u) (> (car u) pos))) us)
                               (fold-left (lambda (best u) (if (and (ok? u) (< (car u) pos)) u best)) #f us))])
                 (if hit (cons (car hit) (cadr hit)) (loop (+ line dir))))))))

    (define (vertical b r dir)
      (let* ([t (buffer-text b)] [n (line-count b)]
             [goal (or (goal-column) (col b (car r)))])
        (let loop ([line (+ dir (text-line-of t (car r)))])
          (and (<= 0 line (- n 1))
               (let ([us (units b line)] [ls (text-line-start t line)])
                 (if (null? us)
                     (loop (+ line dir))
                     ;; The unit under the goal column, or else the nearest.
                     (let ([best (fold-left
                                  (lambda (best u)
                                    (let ([d (let ([cs (- (car u) ls)] [ce (- (max (car u) (- (cadr u) 1)) ls)])
                                               (cond [(< goal cs) (- cs goal)] [(> goal ce) (- goal ce)] [else 0]))])
                                      (if (or (not best) (< d (car best))) (cons d u) best)))
                                  #f us)])
                       (cons (cadr best) (caddr best)))))))))

    (define (current b r)
      (let* ([t (buffer-text b)] [pos (car r)]
             [line (text-line-of t pos)]
             [us (units b line)]
             [hit (or (find (lambda (u) (and (<= (car u) pos) (< pos (cadr u)))) us)
                      (find (lambda (u) (and (= (car u) pos) (= (cadr u) pos))) us)
                      (find (lambda (u) (>= (car u) pos)) us)
                      (and (pair? us) (car (last-pair us))))])
        (if hit
            (cons (car hit) (cadr hit))
            (or (scan b pos 1 #f) (scan b pos -1 #f)))))

    (make-selection-mode
     name label current
     (lambda (b r dir)
       (case dir
         [(right) (scan b (car r) 1 #t)]
         [(left) (scan b (car r) -1 #t)]
         [(next) (scan b (car r) 1 #f)]
         [(previous) (scan b (car r) -1 #f)]
         [(up) (vertical b r -1)]
         [(down) (vertical b r 1)]
         [(first last)
          (let ([us (units b (text-line-of (buffer-text b) (car r)))])
            (and (pair? us)
                 (let ([u (if (eq? dir 'first) (car us) (car (last-pair us)))])
                   (cons (car u) (cadr u)))))]
         [else #f]))
     (lambda (b first last)
       (let loop ([l first] [acc '()])
         (if (> l last)
             (reverse acc)
             (loop (+ l 1) (append (reverse (map (lambda (u) (cons (car u) (cadr u)))
                                                 (filter caddr (units b l))))
                                   acc)))))
     #f))

  ;; ---------------------------------------------------------------------------
  ;; Paragraphs: runs of non-blank lines.

  (define paragraph-mode
    (let ()
      (define (para-at t line)
        ;; The paragraph containing `line`, or #f if it is blank.
        (and (not (blank-line? t line))
             (let ([n (text-line-count t)])
               (let ([first (let loop ([l line]) (if (and (> l 0) (not (blank-line? t (- l 1)))) (loop (- l 1)) l))]
                     [last (let loop ([l line]) (if (and (< l (- n 1)) (not (blank-line? t (+ l 1)))) (loop (+ l 1)) l))])
                 (cons (text-line-start t first) (text-line-end t last))))))
      (define (find-para t line step)
        (let ([n (text-line-count t)])
          (let loop ([l line])
            (and (<= 0 l (- n 1))
                 (or (para-at t l) (loop (+ l step)))))))
      (make-selection-mode
       'paragraph "PARAGRAPH"
       (lambda (b r)
         (let* ([t (buffer-text b)] [l (text-line-of t (car r))])
           (or (find-para t l 1) (find-para t l -1))))
       (lambda (b r dir)
         (let* ([t (buffer-text b)] [n (text-line-count t)])
           (case dir
             [(right down next)
              (find-para t (+ 1 (text-line-of t (cdr r))) 1)]
             [(left up previous)
              (let ([l (text-line-of t (car r))])
                (let skip ([l (- l 1)])
                  (cond [(< l 0) #f]
                        [(blank-line? t l) (skip (- l 1))]
                        [else (para-at t l)])))]
             [(first) (find-para t 0 1)]
             [(last) (find-para t (- n 1) -1)]
             [else #f])))
       (lambda (b first last)
         (let ([t (buffer-text b)])
           (let loop ([l first] [acc '()])
             (cond [(> l last) (reverse acc)]
                   [(para-at t l) => (lambda (p) (loop (+ 1 (text-line-of t (cdr p))) (cons p acc)))]
                   [else (loop (+ l 1) acc)]))))
       #t)))

  ;; ---------------------------------------------------------------------------
  ;; Syntax nodes

  (define (vector-fold-left f acc v)
    (let loop ([i 0] [acc acc]) (if (= i (vector-length v)) acc (loop (+ i 1) (f acc (vector-ref v i))))))

  (define (node-range n) (cons (node-start n) (node-end n)))

  (define (find-node b r)
    (let* ([root (buffer-tree b)]
           [n (node-at root (car r) (cdr r))])
      (if (and (eq? n root) (> (vector-length (node-kids root)) 0))
          ;; Between top-level forms: the nearest one, preferring the next.
          (let ([v (node-kids root)])
            (or (let loop ([i 0]) (and (< i (vector-length v))
                                       (if (>= (node-start (vector-ref v i)) (car r)) (vector-ref v i) (loop (+ i 1)))))
                (vector-ref v (- (vector-length v) 1))))
          (and (not (eq? n root)) n))))

  ;; The node exactly at r: the outermost of those with r's range.
  (define (node-of b r)
    (let ([n (find-node b r)])
      (and n
           (let up ([n n])
             (let ([p (node-parent n)])
               (if (and p (node-parent p) (= (node-start p) (node-start n)) (= (node-end p) (node-end n)))
                   (up p)
                   n))))))

  (define (sibling n step)
    (let ([p (node-parent n)] [i (node-index n)])
      (and p i
           (let ([j (+ i step)] [v (node-kids p)])
             (and (<= 0 j (- (vector-length v) 1)) (vector-ref v j))))))

  (define (preorder-next n)
    (if (> (vector-length (node-kids n)) 0)
        (vector-ref (node-kids n) 0)
        (let up ([n n])
          (and (node-parent n)
               (or (sibling n 1) (up (node-parent n)))))))

  (define (preorder-prev n)
    (let ([s (sibling n -1)])
      (if s
          (let down ([s s])
            (let ([v (node-kids s)])
              (if (> (vector-length v) 0) (down (vector-ref v (- (vector-length v) 1))) s)))
          (let ([p (node-parent n)]) (and p (node-parent p) p)))))

  (define node-mode
    (make-selection-mode
     'node "NODE"
     (lambda (b r) (let ([n (node-of b r)]) (and n (node-range n))))
     (lambda (b r dir)
       (let ([n (node-of b r)])
         (and n
              (let ([m (case dir
                         [(right) (sibling n 1)]
                         [(left) (sibling n -1)]
                         [(next) (preorder-next n)]
                         [(previous) (preorder-prev n)]
                         [(up) (let ([p (node-parent n)]) (and p (node-parent p) p))]
                         [(down) (let ([v (node-kids n)]) (and (> (vector-length v) 0) (vector-ref v 0)))]
                         [(first) (let ([p (node-parent n)]) (and p (vector-ref (node-kids p) 0)))]
                         [(last) (let ([p (node-parent n)])
                                   (and p (let ([v (node-kids p)]) (vector-ref v (- (vector-length v) 1)))))]
                         [else #f])])
                (and m (node-range m))))))
     (lambda (b first last)
       (let* ([t (buffer-text b)]
              [lo (text-line-start t first)] [hi (text-line-end t last)])
         (let walk ([n (buffer-tree b)] [acc '()])
           (let ([acc (if (and (node-parent n) (<= lo (node-start n) hi)
                               (not (and (pair? acc) (= (car (car acc)) (node-start n)))))
                          (cons (node-range n) acc)
                          acc)])
             (vector-fold-left (lambda (acc k) (if (and (<= (node-start k) hi) (>= (node-end k) lo)) (walk k acc) acc))
                               acc (node-kids n)))))
       )
     #f))

  ;; ---------------------------------------------------------------------------
  ;; Search matches

  (define search-pattern-key 'search-pattern)
  (define (search-pattern b) (buffer-local b search-pattern-key #f))

  ;; b's search pattern: literal text, or with regex? a regular expression
  ;; (the regex crate's syntax; see kernel/text/search.rs).
  (define search-pattern-set!
    (case-lambda
     [(b p) (search-pattern-set! b p #f)]
     [(b p regex?)
      (buffer-local-set! b search-pattern-key p)
      (buffer-local-set! b 'search-regex? regex?)]))

  ;; b's search, compiled in the kernel, kept while its pattern is: smart
  ;; case, a pattern with no capitals matching either case. (pattern regex?
  ;; search error): search #f, and error what is wrong, if it is no pattern.
  (define (compiled-search b)
    (let ([pat (search-pattern b)] [regex? (buffer-local b 'search-regex? #f)])
      (and pat (> (string-length pat) 0)
           (let ([c (buffer-local b 'search-compiled #f)])
             (if (and c (equal? (car c) pat) (eq? (cadr c) regex?))
                 c
                 (let ([c (guard (e [#t (list pat regex? #f (condition->string e))])
                            (list pat regex?
                                  (search-new pat regex? (not (exists char-upper-case? (string->list pat))))
                                  #f))])
                   (buffer-local-set! b 'search-compiled c)
                   c))))))

  ;; What is wrong with b's search pattern, if it is not a pattern.
  (define (search-error b)
    (let ([c (compiled-search b)]) (and c (cadddr c))))

  ;; Where b's search pattern matches next from pos, in direction dir,
  ;; wrapping around once: (start . end), or #f.
  (define (search-from b pos dir)
    (let* ([c (compiled-search b)] [s (and c (caddr c))] [r (text-rope (buffer-text b))])
      (and s
           (cond
            [(> dir 0) (search-next s r (max 0 pos) #t)]
            ;; Before the start: from the end, around.
            [(< pos 0) (search-prev s r (buffer-length b) #t)]
            [else (search-prev s r pos #t)]))))

  ;; The matches of b's search pattern from start to end, apart.
  (define (search-matches b start end)
    (let* ([c (compiled-search b)] [s (and c (caddr c))])
      (if s (search-all s (text-rope (buffer-text b)) start end) '())))

  (define search-mode
    (make-selection-mode
     'search "SEARCH"
     (lambda (b r) (search-from b (car r) 1))
     (lambda (b r dir)
       (case dir
         [(right next down) (search-from b (+ (car r) 1) 1)]
         [(left previous up) (search-from b (- (car r) 1) -1)]
         [(first) (search-from b 0 1)]
         [(last) (search-from b (buffer-length b) -1)]
         [else #f]))
     (lambda (b first last)
       (let ([t (buffer-text b)])
         (search-matches b (text-line-start t first) (text-line-end t last))))
     #f #f))

  ;; Items: the regions an extension marks as the things a list shows
  ;; (buffer.sls, item), each a unit; movements step from one to the next.
  (define (items b) (filter (lambda (r) (region-get r 'item)) (buffer-regions b)))
  (define (item-range r) (cons (region-start r) (region-end r)))

  (define item-mode
    (make-selection-mode
     'item "ITEM"
     (lambda (b r)
       (let* ([pos (car r)] [is (items b)])
         (cond
          [(find (lambda (i) (and (<= (region-start i) pos) (< pos (region-end i)))) (reverse is)) => item-range]
          [(find (lambda (i) (>= (region-start i) pos)) is) => item-range]
          [(pair? is) (item-range (car (last-pair is)))]
          [else #f])))
     (lambda (b r dir)
       (let ([is (items b)] [pos (car r)])
         (case dir
           [(right next down)
            (let ([i (find (lambda (i) (> (region-start i) pos)) is)]) (and i (item-range i)))]
           [(left previous up)
            (let ([i (find (lambda (i) (< (region-start i) pos)) (reverse is))]) (and i (item-range i)))]
           [(first) (and (pair? is) (item-range (car is)))]
           [(last) (and (pair? is) (item-range (car (last-pair is))))]
           [else #f])))
     (lambda (b first last)
       (let ([t (buffer-text b)])
         (map item-range (filter (lambda (i) (<= (text-line-start t first) (region-start i) (text-line-end t last)))
                                 (items b)))))
     #f #f))

  (for-each define-selection-mode!
            (list (tokens-mode 'char "CHAR" 'char)
                  (tokens-mode 'subword "SUBWORD" 'subword)
                  (tokens-mode 'word "WORD" 'word)
                  (tokens-mode 'big-word "WORD*" 'big-word)
                  (lines-mode 'line "LINE" line-range)
                  (lines-mode 'line-full "LINE*" line-full-range)
                  paragraph-mode node-mode search-mode item-mode)))
