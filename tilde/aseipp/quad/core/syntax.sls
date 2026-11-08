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
          lex-line make-hl-cache hl-cache-invalidate! highlight-region
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
            (immutable indent-unit syntax-indent-unit)))

  (define (default-word-char? c) (or (char-alphabetic? c) (char-numeric? c) (char=? c #\_)))

  (define (lisp-word-char? c)
    (or (char-alphabetic? c) (char-numeric? c)
        (memv c '(#\- #\_ #\! #\? #\* #\< #\> #\= #\/ #\+ #\: #\. #\% #\& #\^ #\~ #\$ #\@))))

  (define (keyword-table . groups)
    (let ([h (make-hashtable string-hash string=?)])
      (for-each (lambda (g) (for-each (lambda (w) (hashtable-set! h w (car g))) (cdr g))) groups)
      h))

  (define plain-syntax
    (make-syntax 'text #f '() '() '() default-word-char? (keyword-table) '() #f #f "  "))

  ;; ---------------------------------------------------------------------------
  ;; Highlighting
  ;;
  ;; States: 0 normal, 1 inside a string (of the first string char), 2 inside
  ;; a string of the second string char, 10+d inside a block comment at depth d.

  (define (match-at? text i s)
    (let ([n (string-length s)] [len (text-length text)])
      (and (<= (+ i n) len)
           (let loop ([j 0])
             (or (= j n) (and (char=? (text-ref text (+ i j)) (string-ref s j)) (loop (+ j 1))))))))

  (define operator-chars (string->list "+-*/=<>!&|^%~?:.@$"))
  (define bracket-chars (string->list "()[]{}"))

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

    ;; Inside a string closed by q: the position after its close, or #f.
    (define (string-end i q)
      (let loop ([i i])
        (cond [(>= i e) #f]
              [(char=? (ch i) #\\) (loop (+ i 2))]
              [(char=? (ch i) q) (+ i 1)]
              [else (loop (+ i 1))])))

    ;; Inside a block comment at depth d: (values end depth) where depth 0
    ;; means it closed at end.
    (define (comment-end i d)
      (let ([open (car (car blocks))] [close (cdr (car blocks))])
        (let loop ([i i] [d d])
          (cond
           [(>= i e) (values e d)]
           [(match-at? text i close)
            (if (= d 1) (values (+ i (string-length close)) 0)
                (loop (+ i (string-length close)) (- d 1)))]
           [(and lisp? (match-at? text i open)) (loop (+ i (string-length open)) (+ d 1))]
           [else (loop (+ i 1) d)]))))

    (define (word-end i)
      (let loop ([i i]) (if (and (< i e) (word? (ch i))) (loop (+ i 1)) i)))

    (define (number-start? i)
      (let ([c (ch i)])
        (or (char-numeric? c)
            (and (memv c '(#\- #\+ #\.)) (< (+ i 1) e) (char-numeric? (ch (+ i 1)))))))

    (define (next-non-space i)
      (let loop ([i i]) (if (and (< i e) (char-whitespace? (ch i))) (loop (+ i 1)) i)))

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
           [(exists (lambda (lc) (match-at? text i lc)) (syntax-line-comments syn))
            (emit i e 'comment)
            0]
           [(and (pair? blocks) (match-at? text i (car (car blocks))))
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

  ;; Lexer states at every 64th line start, valid up to the first edit.
  (define-record-type hl-cache (fields (mutable states)) (protocol (lambda (new) (lambda () (new (make-eqv-hashtable))))))
  (define bucket 64)

  ;; Forget the states after position `pos` of `text`.
  (define (hl-cache-invalidate! c text pos)
    (let ([line (text-line-of text (min pos (text-length text)))])
      (let-values ([(keys vals) (hashtable-entries (hl-cache-states c))])
        (vector-for-each
         (lambda (k) (when (> (* k bucket) line) (hashtable-delete! (hl-cache-states c) k)))
         keys))))

  (define (state-at syn text c line)
    (let* ([b (quotient line bucket)]
           [start (let loop ([k b]) (if (or (= k 0) (hashtable-contains? (hl-cache-states c) k)) k (loop (- k 1))))])
      (let loop ([l (* start bucket)]
                 [st (if (= start 0) 0 (hashtable-ref (hl-cache-states c) start 0))])
        (cond
         [(= l line) st]
         [else
          (let ([st (lex-line syn text (text-line-start text l) (text-line-end text l) st (lambda (s e f) (void)))])
            (when (= 0 (remainder (+ l 1) bucket))
              (hashtable-set! (hl-cache-states c) (quotient (+ l 1) bucket) st))
            (loop (+ l 1) st))]))))

  ;; Highlight lines [first, last]: a vector of span lists, one per line,
  ;; each span (start end face) in buffer positions.
  (define (highlight-region syn text c first last)
    (let ([out (make-vector (+ 1 (- last first)) '())])
      (let loop ([l first] [st (state-at syn text c first)])
        (when (<= l last)
          (let* ([spans '()]
                 [st (lex-line syn text (text-line-start text l) (text-line-end text l) st
                               (lambda (s e f) (set! spans (cons (list s e f) spans))))])
            (vector-set! out (- l first) (reverse spans))
            (when (= 0 (remainder (+ l 1) bucket))
              (hashtable-set! (hl-cache-states c) (quotient (+ l 1) bucket) st))
            (loop (+ l 1) st))))
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
    (define (skip-line i) (let loop ([i i]) (if (and (< i len) (not (char=? (ch i) #\newline))) (loop (+ i 1)) i)))
    (define (skip-block i open close)
      (let loop ([i (+ i (string-length open))] [d 1])
        (cond [(>= i len) len]
              [(match-at? text i close) (if (= d 1) (+ i (string-length close)) (loop (+ i (string-length close)) (- d 1)))]
              [(and lisp? (match-at? text i open)) (loop (+ i (string-length open)) (+ d 1))]
              [else (loop (+ i 1) d)])))
    (define (skip-string i q)
      (let loop ([i (+ i 1)])
        (cond [(>= i len) len] [(char=? (ch i) #\\) (loop (+ i 2))]
              [(char=? (ch i) q) (+ i 1)] [else (loop (+ i 1))])))

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
           [(exists (lambda (lc) (match-at? text i lc)) (syntax-line-comments syn))
            (loop (skip-line i) stack prefix)]
           [(and (pair? blocks) (match-at? text i (car (car blocks))))
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
            (let ([e (let w ([j (min len (+ i 3))]) (if (and (< j len) (word? (ch j))) (w (+ j 1)) j))])
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
            (let ([e (let w ([j (+ i 1)]) (if (and (< j len) (not (delimiter? (ch j)))) (w (+ j 1)) j))])
              (leaf! i e) (loop e stack #f))]
           [(word? c)
            (let ([e (let w ([j (+ i 1)]) (if (and (< j len) (word? (ch j))) (w (+ j 1)) j))])
              (leaf! i e) (loop e stack #f))]
           [else
            (let ([e (let w ([j (+ i 1)])
                       (if (and (< j len) (let ([d (ch j)]) (not (or (word? d) (delimiter? d) (memv d '(#\, #\;)))))) (w (+ j 1)) j))])
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
