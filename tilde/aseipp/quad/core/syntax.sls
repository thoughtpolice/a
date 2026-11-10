;; syntax.sls -- lexical syntax: highlighting and the syntax-node tree
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A language's lexical syntax drives two things: the highlighter, which lexes
;; a line at a time from a carried state (normal, inside a string, or inside a
;; block comment of some depth), and the node tree, which is the structure the
;; NODE selection mode walks. For a Lisp the tree is exactly its
;; s-expressions; for other languages it is the bracket structure, with words
;; and operator runs as leaves.
(library (quad syntax)
  (export make-syntax syntax? syntax-name syntax-lisp? syntax-word-char?
          syntax-line-comment syntax-indent-unit
          plain-syntax keyword-table
          lex-line make-hl-cache hl-cache-edit! highlight-region
          node? node-start node-end node-kids node-parent node-list?
          parse-tree node-at node-index lisp-word-char? default-word-char?)
  (import (chezscheme) (quad util) (quad text))

  ;; (`syntax` itself is Chez Scheme's, so the type is named language.)
  (define-record-type (language make-syntax syntax?)
    (fields (immutable name syntax-name)
            (immutable lisp? syntax-lisp?)                 ; s-expressions: quotes, #\x, nested #| |#
            (immutable line-comments syntax-line-comments) ; list of strings
            (immutable block-comments syntax-block-comments) ; list of (open . close)
            (immutable string-chars syntax-string-chars)   ; list of chars
            (immutable word-char? syntax-word-char?)       ; what words are made of
            (immutable keywords syntax-keywords)           ; word -> face symbol
            (immutable defining syntax-defining)           ; words whose next word is a definition's name
            (immutable line-proc syntax-line-proc)         ; #f, or a custom lexer for a whole line
            (immutable line-comment syntax-line-comment)   ; what a line comment starts with, for toggling
            (immutable indent-unit syntax-indent-unit)))   ; #f, or the mode's indent-unit

  (define (default-word-char? c) (or (char-alphabetic? c) (char-numeric? c) (char=? c #\_)))

  (define (lisp-word-char? c)
    (or (char-alphabetic? c) (char-numeric? c)
        (memv c '(#\- #\_ #\! #\? #\* #\< #\> #\= #\/ #\+ #\: #\. #\% #\& #\^ #\~ #\$ #\@))))

  (define (keyword-table . groups)
    (let ([h (make-hashtable string-hash string=?)])
      (for-each (lambda (g) (for-each (lambda (w) (hashtable-set! h w (car g))) (cdr g))) groups)
      h))

  (define plain-syntax
    (make-syntax 'text #f '() '() '() default-word-char? (keyword-table) '() #f #f #f))

  ;; ---------------------------------------------------------------------------
  ;; Highlighting
  ;;
  ;; States: 0 normal, 1 inside a string (of the first string char), 2 inside
  ;; a string of the second string char, 10+d inside a block comment at depth d.


  (define operator-chars (string->list "+-*/=<>!&|^%~?:.@$"))
  (define bracket-chars (string->list "()[]{}"))

  ;; Scans of text before position end, shared by the highlighter (a line at
  ;; a time) and the node tree (the whole text).

  ;; The first position from i on whose character is not ok?, or end.
  (define (scan-while text i end ok?)
    (let loop ([i i]) (if (and (< i end) (ok? (text-ref text i))) (loop (+ i 1)) i)))

  ;; Inside a string closed by q, from i: the position after its close, or
  ;; #f when it does not close before end. A backslash escapes what follows.
  (define (scan-string text i end q)
    (let loop ([i i])
      (cond [(>= i end) #f]
            [(char=? (text-ref text i) #\\) (loop (+ i 2))]
            [(char=? (text-ref text i) q) (+ i 1)]
            [else (loop (+ i 1))])))

  ;; Inside a block comment from open to close, at depth d, from i:
  ;; (values position depth), depth 0 when it closed just before position,
  ;; else end and the depth there. Comments nest when nest?.
  (define (scan-block text i end open close nest? d)
    (let loop ([i i] [d d])
      (cond
       [(>= i end) (values end d)]
       [(text-match-at? text i close)
        (if (= d 1)
            (values (+ i (string-length close)) 0)
            (loop (+ i (string-length close)) (- d 1)))]
       [(and nest? (text-match-at? text i open)) (loop (+ i (string-length open)) (+ d 1))]
       [else (loop (+ i 1) d)])))

  ;; Lex the line [s, e) from `state`, calling (emit start end face) for each
  ;; highlighted token; returns the state at the end of the line.
  (define (lex-line syn text s e state emit)
    (if (syntax-line-proc syn)
        ((syntax-line-proc syn) text s e state emit)
        (lex-line* syn text s e state emit)))

  (define (lex-line* syn text s e state emit)
    (define lisp? (syntax-lisp? syn))
    (define word? (syntax-word-char? syn))
    (define strs (syntax-string-chars syn))
    (define blocks (syntax-block-comments syn))
    (define (ch i) (text-ref text i))
    (define (string-end i q) (scan-string text i e q))
    (define (comment-end i d) (scan-block text i e (car (car blocks)) (cdr (car blocks)) lisp? d))
    (define (word-end i) (scan-while text i e word?))

    (define (number-start? i)
      (let ([c (ch i)])
        (or (char-numeric? c)
            (and (memv c '(#\- #\+ #\.)) (< (+ i 1) e) (char-numeric? (ch (+ i 1)))))))

    (define (next-non-space i) (scan-while text i e char-whitespace?))

    (let loop ([i s] [state state] [def 0])
      (cond
       [(>= i e) state]
       [(or (= state 1) (= state 2))
        (let ([end (string-end i (list-ref strs (- state 1)))])
          (emit i (or end e) 'string)
          (if end (loop end 0 0) state))]
       [(>= state 10)
        (let-values ([(end d) (comment-end i (- state 10))])
          (emit i end 'comment)
          (if (= d 0) (loop end 0 def) (+ 10 d)))]
       [else
        (let ([c (ch i)])
          (cond
           [(char-whitespace? c) (loop (+ i 1) 0 def)]
           [(exists (lambda (lc) (text-match-at? text i lc)) (syntax-line-comments syn))
            (emit i e 'comment)
            0]
           [(and (pair? blocks) (text-match-at? text i (car (car blocks))))
            (loop (+ i (string-length (car (car blocks)))) 11 def)]
           [(memv c strs)
            (let ([end (string-end (+ i 1) c)])
              (emit i (or end e) 'string)
              (if end (loop end 0 0) (if (eqv? c (car strs)) 1 2)))]
           [(and lisp? (char=? c #\#) (< (+ i 1) e) (char=? (ch (+ i 1)) #\\))
            ;; #\a, #\space, #\x41
            (let ([end (if (< (+ i 2) e) (word-end (+ i 3)) e)])
              (emit i (min e end) 'constant.character)
              (loop (min e end) 0 0))]
           [(and lisp? (char=? c #\#) (< (+ i 1) e) (char=? (ch (+ i 1)) #\;))
            (emit i (+ i 2) 'comment)
            (loop (+ i 2) 0 def)]
           [(and lisp? (memv c '(#\' #\` #\,)))
            (let ([n (if (and (char=? c #\,) (< (+ i 1) e) (char=? (ch (+ i 1)) #\@)) 2 1)])
              (emit i (+ i n) 'operator)
              (loop (+ i n) 0 def))]
           [(and lisp? (char=? c #\#) (< (+ i 1) e) (memv (ch (+ i 1)) '(#\' #\` #\,)))
            (emit i (+ i 2) 'operator)
            (loop (+ i 2) 0 def)]
           [(memv c bracket-chars)
            (emit i (+ i 1) 'punctuation.bracket)
            (loop (+ i 1) 0 (if (and (= def 1) (char=? c #\()) 2 (if (= def 2) 0 def)))]
           [(number-start? i)
            (let ([end (max (+ i 1) (word-end (+ i 1)))])
              (emit i end 'constant.numeric)
              (loop end 0 0))]
           [(or (word? c) (and (char=? c #\#) (< (+ i 1) e) (word? (ch (+ i 1)))))
            (let* ([end (word-end (+ i 1))]
                   [w (text-substring text i end)]
                   [face (hashtable-ref (syntax-keywords syn) w #f)])
              (cond
               [face (emit i end face)]
               [(> def 0) (emit i end 'function)]
               [(and (not lisp?) (< (next-non-space end) e) (char=? (ch (next-non-space end)) #\())
                (emit i end 'function)]
               [(and (not lisp?) (char-upper-case? c) (> (- end i) 1)) (emit i end 'type)])
              (loop end 0 (if (member w (syntax-defining syn)) 1 0)))]
           [(memv c operator-chars)
            (emit i (+ i 1) 'operator)
            (loop (+ i 1) 0 def)]
           [else (emit i (+ i 1) 'punctuation) (loop (+ i 1) 0 def)]))])))

  ;; Lexer states at line starts, a checkpoint about every 64 lines, kept
  ;; across edits so that lexing after one goes only as far as it must.
  ;;
  ;; An edit drops the checkpoints among the lines it changed and moves the
  ;; ones below it by the lines it added or removed, marking them stale: they
  ;; hold the states the old text had there. Lexing down from the edit
  ;; compares the state it reaches with each stale checkpoint it comes to;
  ;; once they agree, the lines below lex as they did before, and the stale
  ;; checkpoints are good again -- as far as the next edit's, which can be
  ;; trusted only once lexing reaches that edit in turn. So the checkpoints
  ;; are a run of good ones followed by stale ones, and the damage list
  ;; (sorted lines, each an edit's first line) splits the stale ones into
  ;; the runs that agree among themselves: those between one damage line
  ;; and the next.
  (define-record-type point (fields (mutable line) (mutable state) (mutable stale?)))
  ;; points: a list behind a head pair, sorted by line, so that checkpoints
  ;; can be put in and taken out in place. syntax: the lexer the states are
  ;; for; another one's are no use.
  (define-record-type hl-cache
    (fields (mutable syntax) (mutable points) (mutable damage))
    (protocol (lambda (new) (lambda () (new #f (list 'head) '())))))
  (define spacing 64)

  ;; An edit changed lines l1 to l2 of the old text, and added delta lines
  ;; (removed, if negative).
  (define (hl-cache-edit! c l1 l2 delta)
    (let loop ([prev (hl-cache-points c)] [moved? #f])
      (let ([rest (cdr prev)])
        (if (null? rest)
            (let ([ds (filter-map (lambda (d) (cond [(<= d l1) d] [(<= d l2) #f] [else (+ d delta)]))
                                  (hl-cache-damage c))])
              (hl-cache-damage-set! c (if (or (not moved?) (memv l1 ds)) ds (sort < (cons l1 ds)))))
            (let* ([p (car rest)] [l (point-line p)])
              (cond
               [(<= l l1) (loop rest moved?)]
               [(<= l l2) (set-cdr! prev (cdr rest)) (loop prev moved?)]
               [else (point-line-set! p (+ l delta)) (point-stale?-set! p #t) (loop rest #t)]))))))

  ;; The last good checkpoint's pair at or before line, or the head.
  (define (good-before c line)
    (let loop ([prev (hl-cache-points c)])
      (let ([rest (cdr prev)])
        (if (and (pair? rest) (not (point-stale? (car rest))) (<= (point-line (car rest)) line))
            (loop rest)
            prev))))

  ;; Lex lines up to last, starting from the best state there is for line
  ;; first; for lines first to last, (emit line spans). Checkpoints are
  ;; checked, made good and added on the way.
  (define (walk! syn text c first last emit)
    (unless (eq? (hl-cache-syntax c) syn)
      (hl-cache-syntax-set! c syn)
      (hl-cache-points-set! c (list 'head))
      (hl-cache-damage-set! c '()))
    (let ([lines (text-line-count text)])
      (define (line-of pr) (if (point? (car pr)) (point-line (car pr)) 0))
      (define (state-of pr) (if (point? (car pr)) (point-state (car pr)) 0))
      ;; Agreement at a stale checkpoint at line l: it and the ones after it
      ;; up to the next damage line are good, and so are the edits above it.
      (define (agree! rest l)
        (let ([d (find (lambda (d) (>= d l)) (hl-cache-damage c))])
          (let loop ([r rest])
            (when (and (pair? r) (or (not d) (<= (point-line (car r)) d)))
              (point-stale?-set! (car r) #f)
              (loop (cdr r))))
          (hl-cache-damage-set! c (filter (lambda (x) (>= x l)) (hl-cache-damage c)))))
      ;; Done at line l: the edits above it are lexed past, and the stale
      ;; checkpoints left below it are a run of their own.
      (define (finish! prev l)
        (let* ([ds (filter (lambda (x) (>= x l)) (hl-cache-damage c))]
               [next (cdr prev)])
          (hl-cache-damage-set!
           c (if (and (pair? next) (point-stale? (car next))
                      (not (and (pair? ds) (< (car ds) (point-line (car next))))))
                 (cons l ds)
                 ds))))
      (let loop ([prev (good-before c first)])
        (letrec
            ;; st: the state at line l's start, checkpoints before l seen to;
            ;; base: the line of the last checkpoint at or before l.
            ([walk
              (lambda (l st prev base)
                (let ([next (cdr prev)])
                  (cond
                   [(and (pair? next) (= (point-line (car next)) l))
                    (let ([p (car next)])
                      (cond
                       [(not (point-stale? p)) (continue l (point-state p) next l)]
                       [(equal? (point-state p) st)
                        (agree! next l)
                        (if (< l first) (loop (good-before c first)) (continue l st next l))]
                       [else (point-state-set! p st) (point-stale?-set! p #f) (continue l st next l)]))]
                   [(and (>= (- l base) spacing) (< l lines))
                    (let ([pr (cons (make-point l st #f) next)])
                      (set-cdr! prev pr)
                      (continue l st pr l))]
                   [else (continue l st prev base)])))]
             ;; Lex line l, unless it is past last.
             [continue
              (lambda (l st prev base)
                (if (or (> l last) (>= l lines))
                    (finish! prev l)
                    (let* ([spans '()]
                           [st (lex-line syn text (text-line-start text l) (text-line-end text l) st
                                         (if (< l first)
                                             (lambda (s e f) (void))
                                             (lambda (s e f) (set! spans (cons (list s e f) spans)))))])
                      (when (>= l first) (emit l (reverse spans)))
                      (walk (+ l 1) st prev base))))])
          (walk (line-of prev) (state-of prev) prev (line-of prev))))))

  ;; Highlight lines [first, last]: a vector of span lists, one per line,
  ;; each span (start end face) in buffer positions.
  (define (highlight-region syn text c first last)
    (let ([out (make-vector (+ 1 (- last first)) '())])
      (walk! syn text c first last (lambda (l spans) (vector-set! out (- l first) spans)))
      out))

  ;; ---------------------------------------------------------------------------
  ;; The node tree

  (define-record-type node
    (fields start (mutable end) (mutable kids) (mutable parent) list?)
    (protocol (lambda (new) (lambda (start end list?) (new start end '() #f list?)))))

  (define (close-node! n end)
    (node-end-set! n end)
    (node-kids-set! n (list->vector (reverse (node-kids n)))))

  (define (add-kid! parent kid)
    (node-parent-set! kid parent)
    (node-kids-set! parent (cons kid (node-kids parent))))

  (define (parse-tree syn text)
    (define len (text-length text))
    (define lisp? (syntax-lisp? syn))
    (define word? (syntax-word-char? syn))
    (define strs (syntax-string-chars syn))
    (define blocks (syntax-block-comments syn))
    (define root (make-node 0 len #t))
    (define (ch i) (text-ref text i))
    (define (open? c) (memv c '(#\( #\[ #\{)))
    (define (close? c) (memv c '(#\) #\] #\})))
    (define (delimiter? c)
      (or (char-whitespace? c) (open? c) (close? c) (memv c strs) (and lisp? (char=? c #\;))))
    (define (skip-line i) (scan-while text i len (lambda (c) (not (char=? c #\newline)))))
    ;; Past the block comment or string opening at i (to the end, unclosed).
    (define (skip-block i open close)
      (let-values ([(end d) (scan-block text (+ i (string-length open)) len open close lisp? 1)]) end))
    (define (skip-string i q) (or (scan-string text (+ i 1) len q) len))
    (define (leaf-end i ok?) (scan-while text i len ok?))

    (let loop ([i 0] [stack (list root)] [prefix #f])
      (define (leaf! s e) (add-kid! (car stack) (make-node-closed (or prefix s) e)))
      (cond
       [(>= i len)
        (for-each (lambda (n) (unless (eq? n root) (close-node! n len))) stack)
        (close-node! root len)
        root]
       [else
        (let ([c (ch i)])
          (cond
           [(char-whitespace? c) (loop (+ i 1) stack prefix)]
           [(exists (lambda (lc) (text-match-at? text i lc)) (syntax-line-comments syn))
            (loop (skip-line i) stack prefix)]
           [(and (pair? blocks) (text-match-at? text i (car (car blocks))))
            (loop (skip-block i (car (car blocks)) (cdr (car blocks))) stack prefix)]
           [(memv c strs)
            (let ([e (skip-string i c)]) (leaf! i e) (loop e stack #f))]
           [(open? c)
            (let ([n (make-node (or prefix i) #f #t)])
              (add-kid! (car stack) n)
              (loop (+ i 1) (cons n stack) #f))]
           [(close? c)
            (if (null? (cdr stack))
                (loop (+ i 1) stack #f)
                (begin (close-node! (car stack) (+ i 1)) (loop (+ i 1) (cdr stack) #f)))]
           [(and lisp? (char=? c #\#) (< (+ i 1) len) (char=? (ch (+ i 1)) #\\))
            (let ([e (leaf-end (min len (+ i 3)) word?)])
              (leaf! i e) (loop e stack #f))]
           [(and lisp? (memv c '(#\' #\` #\,)))
            (let ([n (if (and (char=? c #\,) (< (+ i 1) len) (char=? (ch (+ i 1)) #\@)) 2 1)])
              (loop (+ i n) stack (or prefix i)))]
           [(and lisp? (char=? c #\#) (< (+ i 1) len) (memv (ch (+ i 1)) '(#\' #\` #\, #\( #\;)))
            (if (char=? (ch (+ i 1)) #\()
                (loop (+ i 1) stack (or prefix i))
                (loop (+ i 2) stack (or prefix i)))]
           [(and (not lisp?) (memv c '(#\, #\;))) (loop (+ i 1) stack #f)]
           [lisp?
            (let ([e (leaf-end (+ i 1) (lambda (d) (not (delimiter? d))))])
              (leaf! i e) (loop e stack #f))]
           [(word? c)
            (let ([e (leaf-end (+ i 1) word?)])
              (leaf! i e) (loop e stack #f))]
           [else
            (let ([e (leaf-end (+ i 1) (lambda (d) (not (or (word? d) (delimiter? d) (memv d '(#\, #\;))))))])
              (leaf! i e) (loop e stack #f))]))])))

  (define (make-node-closed s e)
    (let ([n (make-node s e #f)]) (node-kids-set! n (vector)) n))

  ;; The smallest node containing [s, e), preferring one that starts at s.
  (define (node-at root s e)
    (let loop ([n root])
      (let ([kid (let ([v (node-kids n)])
                   (let find ([i 0])
                     (cond [(= i (vector-length v)) #f]
                           [(let ([k (vector-ref v i)])
                              (and (<= (node-start k) s) (>= (node-end k) e)
                                   (not (and (= s e) (= (node-end k) s)))))
                            (vector-ref v i)]
                           [else (find (+ i 1))])))])
        (if kid (loop kid) n))))

  (define (node-index n)
    (let ([p (node-parent n)])
      (and p (let ([v (node-kids p)])
               (let loop ([i 0]) (cond [(= i (vector-length v)) #f] [(eq? (vector-ref v i) n) i] [else (loop (+ i 1))])))))))
