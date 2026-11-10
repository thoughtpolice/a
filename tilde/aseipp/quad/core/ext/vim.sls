;; vim.sls -- Vim's keys
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The key scheme 'vim (keymap.sls): (set-var! 'key-scheme 'vim). Normal
;; mode moves a cursor a character wide with Vim's motions (h j k l, w b e
;; and W B E, 0 ^ $, gg G, f t F T and ; ,, { }, %, H M L, n N * #), a
;; count before any of them (and after an operator: 2d3w); its operators (d c y > < and g~ gu gU) take a
;; motion, a text object (iw aw iW aW, i( a( ib, i[ a[, i{ a{ iB, i< a<,
;; i" a" i' a' i` a`, ip ap) or themselves again (dd yy cc >> <<); x X D C
;; s S Y p P J r ~ u ctrl+r; i a I A o O insert; v and V select (visual
;; mode), where the operators act on what is selected and o swaps its
;; ends; / ? search; : runs ex commands (vi.sls); zz centers; ctrl+d
;; ctrl+u ctrl+f ctrl+b scroll. "x names a register for the next yank,
;; delete or put (vi.sls has which there are); q x records a macro until q
;; again, @x plays it (@@ the last again); . repeats the last change, with
;; a count instead of its own if one is typed. The space menu, panes
;; (ctrl+w) and insert mode are quad's, as in every scheme. Not here:
;; marks, replace mode, a macro stopping where a motion fails.
(library (quad ext vim)
  (export vim-keymap)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad ext vi))

  (define vim-keymap (make-keymap 'vim "Vim"))

  ;; ---------------------------------------------------------------------------
  ;; Motions: (key kind target), target (p n) -> where n of them from p go;
  ;; kind 'exclusive, 'inclusive or 'linewise, as an operator takes them.

  (define (times n f p) (if (<= n 0) p (times (- n 1) f (f p))))

  (define last-find #f)                 ; (char dir till?)

  ;; The nth ch from p in direction dir on its line (till?: the character
  ;; before it, coming from p); p, if there are not that many.
  (define (find-target ch dir till? p n)
    (let loop ([i n] [from p] [last #f])
      (if (= i 0)
          (if till? (- last dir) last)
          (let ([f (find-in-line from ch dir)])
            (if f (loop (- i 1) f f) (if last (if till? (- last dir) last) p))))))

  (define (column p) (- p (bol p)))

  ;; Down (step 1) or up (-1) n lines, at the column the run of them aims
  ;; for.
  (define (line-step p n step)
    (let* ([v (current-view)]
           [col (or (view-local v 'vim-col #f) (let ([c (column p)]) (view-local-set! v 'vim-col c) c))]
           [last (last-line)]
           [line (clamp (+ (line-of p) (* n step)) 0 last)])
      (min (+ (line-start line) col) (max (line-start line) (- (line-end line) 1)))))

  (define (screen-line which)
    (let ([g (view-geometry)] [v (current-view)])
      (let* ([top (view-top v)] [rows (if g (caddr g) 20)]
             [last (last-line)]
             [line (min last (case which [(top) top] [(middle) (+ top (quotient (min rows (- (+ last 1) top)) 2))]
                                    [else (min last (+ top rows -1))]))])
        (first-nonblank (line-start line)))))

  (define (paragraph p dir)
    (let ([r ((selection-mode-move (find-selection-mode 'paragraph)) (vi-buffer) (cons p p)
                                                                   (if (> dir 0) 'next 'previous))])
      (if r (car r) (if (> dir 0) (vi-len) 0))))

  (define motions
    (list
     (list "h" 'exclusive (lambda (p n) (max (bol p) (- p n))))
     (list "left" 'exclusive (lambda (p n) (max (bol p) (- p n))))
     (list "l" 'exclusive (lambda (p n) (min (eol p) (+ p n))))
     (list "right" 'exclusive (lambda (p n) (min (eol p) (+ p n))))
     (list "j" 'linewise (lambda (p n) (line-step p n 1)))
     (list "down" 'linewise (lambda (p n) (line-step p n 1)))
     (list "k" 'linewise (lambda (p n) (line-step p n -1)))
     (list "up" 'linewise (lambda (p n) (line-step p n -1)))
     (list "w" 'exclusive (lambda (p n) (times n (lambda (p) (word-forward 'word p)) p)))
     (list "W" 'exclusive (lambda (p n) (times n (lambda (p) (word-forward 'big-word p)) p)))
     (list "b" 'exclusive (lambda (p n) (times n (lambda (p) (word-backward 'word p)) p)))
     (list "B" 'exclusive (lambda (p n) (times n (lambda (p) (word-backward 'big-word p)) p)))
     (list "e" 'inclusive (lambda (p n) (times n (lambda (p) (word-end 'word p)) p)))
     (list "E" 'inclusive (lambda (p n) (times n (lambda (p) (word-end 'big-word p)) p)))
     (list "0" 'exclusive (lambda (p n) (bol p)))
     (list "home" 'exclusive (lambda (p n) (bol p)))
     (list "^" 'exclusive (lambda (p n) (first-nonblank p)))
     (list "$" 'inclusive (lambda (p n) (last-char (line-step p (- n 1) 1))))
     (list "end" 'inclusive (lambda (p n) (last-char p)))
     (list "G" 'linewise (lambda (p n)
                           (let ([last (last-line)])
                             (first-nonblank (line-start (if (count-given) (min last (- n 1)) last))))))
     (list "}" 'exclusive (lambda (p n) (times n (lambda (p) (paragraph p 1)) p)))
     (list "{" 'exclusive (lambda (p n) (times n (lambda (p) (paragraph p -1)) p)))
     (list "%" 'inclusive (lambda (p n) (or (matching-bracket p) p)))
     (list "H" 'linewise (lambda (p n) (screen-line 'top)))
     (list "M" 'linewise (lambda (p n) (screen-line 'middle)))
     (list "L" 'linewise (lambda (p n) (screen-line 'bottom)))
     (list "n" 'exclusive (lambda (p n) (let ([m (search-step p #t)]) (if m (car m) p))))
     (list "N" 'exclusive (lambda (p n) (let ([m (search-step p #f)]) (if m (car m) p))))
     (list ";" 'inclusive (lambda (p n) (if last-find (apply find-target (append last-find (list p n))) p)))
     (list "," 'inclusive (lambda (p n)
                            (if last-find
                                (find-target (car last-find) (- (cadr last-find)) (caddr last-find) p n)
                                p)))))

  ;; Whether the count was typed, for the motion running now (G: a line).
  (define given-count #f)
  (define (count-given) given-count)

  (define (motion-target m p)
    (let ([pre op-count])
      (set! given-count (or pre (count-pending?)))
      (let ([n (op-count!)])
        (let ([q ((caddr m) p n)])
          (set! given-count #f)
          q))))

  ;; An operator's count, typed before it, times its motion's, typed after:
  ;; 2d3w deletes six words.
  (define op-count #f)
  (define (op-count!)
    (let ([pre op-count])
      (set! op-count #f)
      (* (or pre 1) (take-count!))))

  ;; ---------------------------------------------------------------------------
  ;; Moving

  ;; In normal mode the cursor rests on a character of its line, not past
  ;; the last.
  (define (rest p) (min p (last-char p)))

  (define (vim-move! m)
    (unless (eq? (cadr m) 'linewise) (view-local-set! (current-view) 'vim-col #f))
    (let ([q (motion-target m (head))])
      (if (selecting?)
          (select-set-head! q)
          (set-cursors! (list (if (eq? (cadr m) 'linewise) q (rest q)))))))

  ;; ---------------------------------------------------------------------------
  ;; Operators: on a range [s, e), linewise? whole lines

  (define (operate! op s e linewise?)
    (let* ([b (vi-buffer)] [n (vi-len)] [s (clamp s 0 n)] [e (clamp e s n)]
           [text (buffer-substring b s e)])
      (case op
        [(delete)
         (yank! text linewise? 'delete)
         (buffer-delete! b s e)
         (set-cursors! (list (if linewise? (first-nonblank (on-line (min s (vi-len)))) (rest (min s (vi-len))))))]
        [(change)
         ;; A line changed keeps its newline, as the text it had ends.
         (let ([e (if (and linewise? (> e s) (char=? (string-ref text (- (string-length text) 1)) #\newline)) (- e 1) e)])
           (yank! (buffer-substring b s e) linewise? 'delete)
           (buffer-delete! b s e)
           (set-sels! b (list (make-sel s s)))
           (enter-insert! 'start))]
        [(yank) (yank! text linewise? 'yank) (set-cursors! (list s))]
        [(indent dedent)
         (set-sels! b (list (make-sel s (max s (- e 1)))))
         (run-command op)
         (set-cursors! (list (first-nonblank (min s (vi-len)))))]
        [(upper lower toggle)
         (buffer-edit! b (list (list s e (case op
                                           [(upper) (string-upcase text)]
                                           [(lower) (string-downcase text)]
                                           [else (list->string (map (lambda (c) (if (char-upper-case? c) (char-downcase c) (char-upcase c)))
                                                                    (string->list text)))]))))
         (set-cursors! (list s))])))

  ;; The range of lines from p's to q's, with the last's newline.
  (define (lines-range p q)
    (values (bol (min p q)) (min (vi-len) (+ (eol (max p q)) 1))))

  (define pending-op #f)
  (define pending-key #f)               ; the key that gave it

  ;; The operator waiting for its motion, taken.
  (define (take-op!) (let ([op pending-op]) (set! pending-op #f) op))

  (define (operate-motion! m)
    (let* ([p (head)] [op (take-op!)]
           ;; cw is ce, on a word, as in Vim.
           [m (if (and (eq? op 'change) (member (car m) '("w" "W"))
                       (< p (vi-len)) (not (char-whitespace? (text-ref (buffer-text (vi-buffer)) p))))
                  (assoc (if (string=? (car m) "w") "e" "E") motions)
                  m)]
           [q (motion-target m p)])
      (case (cadr m)
        [(linewise) (let-values ([(s e) (lines-range p q)]) (operate! op s e #t))]
        [(inclusive) (operate! op (min p q) (+ 1 (max p q)) #f)]
        [else (operate! op (min p q) (max p q) #f)])))

  ;; The operator, on n lines from the cursor's (dd, yy, cc, >>, <<).
  (define (operate-lines! op n)
    (let ([p (head)])
      (let-values ([(s e) (lines-range p (line-start (min (last-line)
                                                           (+ (line-of p) (- n 1)))))])
        (operate! op s e #t))))

  ;; Text objects: the range of one around the cursor.
  (define (word-object mode around?)
    (let* ([p (head)] [m (find-selection-mode mode)]
           [r ((selection-mode-current m) (vi-buffer) (cons p (min (vi-len) (+ p 1))))])
      (and r
           (if around?
               (let loop ([e (cdr r)])
                 (if (and (< e (vi-len)) (memv (text-ref (buffer-text (vi-buffer)) e) '(#\space #\tab)))
                     (loop (+ e 1))
                     (cons (car r) e)))
               r))))

  (define (enclosure-object c around?)
    (let ([enc (enclosure-of c)])
      (and enc
           (let* ([p (head)] [found (enclosure-at p (min (vi-len) (+ p 1)) (car enc) (cadr enc))])
             (and found (if around? (cons (car found) (+ 1 (cdr found))) (cons (+ 1 (car found)) (cdr found))))))))

  (define (paragraph-object around?)
    (let* ([p (head)]
           [r ((selection-mode-current (find-selection-mode 'paragraph)) (vi-buffer) (cons p p))])
      r))

  ;; Do with object range r what is pending, or select it.
  (define (object! r)
    (cond
     [(not r) (set! pending-op #f) (set! op-count #f) (message "No such object here")]
     [pending-op (set! op-count #f) (operate! (take-op!) (car r) (cdr r) #f)]
     [else (select-start! 'char)
           (view-local-set! (current-view) 'vi-anchor (car r))
           (select-set-head! (max (car r) (- (cdr r) 1)))]))

  (define (object-keymap around?)
    (let ([km (make-keymap (if around? 'vim-around 'vim-inside) (if around? "Around" "Inside"))])
      (define-key km "w" (lambda () (object! (word-object 'word around?))) "word")
      (define-key km "W" (lambda () (object! (word-object 'big-word around?))) "WORD")
      (define-key km "p" (lambda () (object! (paragraph-object around?))) "paragraph")
      (for-each (lambda (c)
                  (define-key km (string c) (lambda () (object! (enclosure-object c around?))) (string c)))
                (string->list "()b[]{}B<>\"'`"))
      km))

  (define inside-keymap (object-keymap #f))
  (define around-keymap (object-keymap #t))

  ;; The keys after an operator: a motion, an object, itself again, a count.
  (define operator-keymap (make-keymap 'vim-operator "Operator"))

  ;; f t F T and a character. Forwards, an operator takes the character
  ;; reached; backwards, not the one it started on.
  (define (find-keymap dir till? run)
    (char-keymap 'vim-find (if till? "Till" "Find")
                 (lambda (c)
                   (set! last-find (list c dir till?))
                   (run (list "f" (if (> dir 0) 'inclusive 'exclusive)
                              (lambda (p n) (find-target c dir till? p n)))))))

  (define (bind-motions! km run)
    (for-each (lambda (m) (define-key km (car m) (lambda () (run m)) (car m))) motions)
    (define-key km "f" (find-keymap 1 #f run) "Find →")
    (define-key km "F" (find-keymap -1 #f run) "Find ←")
    (define-key km "t" (find-keymap 1 #t run) "Till →")
    (define-key km "T" (find-keymap -1 #t run) "Till ←")
    (let ([g (make-keymap 'vim-g "Go")])
      (define-key g "g" (lambda ()
                          (run (list "gg" 'linewise
                                     (lambda (p n) (first-nonblank (line-start (if (count-given) (- n 1) 0))))))) "First Line")
      (define-key g "e" (lambda () (run (list "ge" 'inclusive (lambda (p n) (max 0 (- (word-backward 'word p) 1)))))) "← Word End")
      (define-key km "g" g "Go")))

  (at-load
   (bind-motions! operator-keymap (lambda (m) (operate-motion! m)))
   (define-key operator-keymap "i" inside-keymap "Inside")
   (define-key operator-keymap "a" around-keymap "Around")
   (for-each (lambda (k)
               (define-key operator-keymap k (lambda () (operate-lines! (take-op!) (op-count!))) "Lines"))
             '("d" "c" "y" ">" "<" "~" "u" "U"))
   ;; A count after the operator, before its motion; 0 is a digit after
   ;; another, else the motion.
   (do ([d 1 (+ d 1)]) ((> d 9))
     (let ([d d])
       (define-key operator-keymap (number->string d)
         (lambda () (count-digit! d) (enter-layer! operator-keymap pending-key)) "Count")))
   (define-key operator-keymap "0"
     (lambda ()
       (if (count-pending?)
           (begin (count-digit! 0) (enter-layer! operator-keymap pending-key))
           (operate-motion! (assoc "0" motions))))
     "Line Start"))

  ;; An operator's key: on what is selected, in visual mode; else, wait
  ;; for its motion.
  (define (operator op key)
    (lambda ()
      (unless (eq? op 'yank) (change-made!))
      (if (selecting?)
          (let* ([a (select-anchor)] [h (head)] [line? (eq? (select-kind) 'line)])
            (view-local-set! (current-view) 'vi-select #f)
            (if line?
                (let-values ([(s e) (lines-range a h)]) (operate! op s e #t))
                (operate! op (min a h) (+ 1 (max a h)) #f)))
          (begin
            (set! pending-op op)
            (set! pending-key key)
            (set! op-count (and (count-pending?) (take-count!)))
            (enter-layer! operator-keymap key)))))

  ;; ---------------------------------------------------------------------------
  ;; Other commands

  (define (count-times! f) (let ([n (take-count!)]) (do ([i 0 (+ i 1)]) ((= i n)) (f))))

  (define (paste! after?)
    (change-made!)
    (let ([r (register-fetch)] [p (head)] [n (take-count!)] [b (vi-buffer)])
      (when r
        (let ([text (apply string-append (make-list n (string-join (car r) "\n")))])
          (if (cdr r)
              (let ([at (if after? (min (vi-len) (+ (eol p) 1)) (bol p))])
                ;; A last line with no newline gets one, to put lines after.
                (if (and after? (= (eol p) (vi-len)))
                    (begin (buffer-insert! b (vi-len) (string-append "\n" text))
                           (set-cursors! (list (+ at 1))))
                    (begin (buffer-insert! b at text) (set-cursors! (list (first-nonblank at))))))
              (let ([at (if (and after? (< p (eol p))) (+ p 1) p)])
                (buffer-insert! b at text)
                (set-cursors! (list (+ at (string-length text) -1)))))))))

  (define (replace-char! c)
    (change-made!)
    (let* ([p (head)] [n (take-count!)] [e (min (eol p) (+ p n))])
      (when (= (- e p) n)
        (buffer-edit! (vi-buffer) (list (list p e (make-string n c))))
        (set-cursors! (list (- e 1))))))

  (define (insert-at! where)
    (change-made!)
    (select-stop!)
    (let ([p (head)])
      (case where
        [(before) (set-sels! (vi-buffer) (list (make-sel p p))) (enter-insert! 'start)]
        [(after) (set-sels! (vi-buffer) (list (make-sel (min (eol p) (+ p 1)) (min (eol p) (+ p 1))))) (enter-insert! 'start)]
        [(line-start) (let ([q (first-nonblank p)]) (set-sels! (vi-buffer) (list (make-sel q q))) (enter-insert! 'start))]
        [(line-end) (let ([q (eol p)]) (set-sels! (vi-buffer) (list (make-sel q q))) (enter-insert! 'start))])))

  (define (visual! kind)
    (cond
     [(eq? (select-kind) kind) (select-stop!)]
     [(selecting?) (view-local-set! (current-view) 'vi-select kind) (select-set-head! (head))]
     [else (select-start! kind)]))

  (define (search-word! dir)
    (let* ([p (head)] [m (find-selection-mode 'word)]
           [r ((selection-mode-current m) (vi-buffer) (cons p (min (vi-len) (+ p 1))))])
      (when r
        (let ([w (buffer-substring (vi-buffer) (car r) (cdr r))])
          (search-pattern-set! (vi-buffer) (string-append "\\b" (escape-regex w) "\\b") #t)
          (buffer-local-set! (vi-buffer) 'vi-search-dir dir)
          (let ([found (search-step p #t)]) (when found (set-cursors! (list (car found)))))))))

  (define record-keymap (char-keymap 'vim-record "Record Into" record-start!))

  (define (escape-regex s)
    (list->string (apply append (map (lambda (c) (if (memv c (string->list "\\.+*?()|[]{}^$#&-~")) (list #\\ c) (list c)))
                                     (string->list s)))))

  (at-load
   (bind-motions! vim-keymap vim-move!)
   (do ([d 1 (+ d 1)]) ((> d 9))
     (let ([d d]) (define-key vim-keymap (number->string d) (lambda () (count-digit! d)) "Count")))
   ;; 0 is a digit after another, else the line's start.
   (define-key vim-keymap "0" (lambda () (if (count-pending?) (count-digit! 0) (vim-move! (assoc "0" motions)))) "Line Start")
   (bind vim-keymap
         "d" (operator 'delete "d") "Delete" "c" (operator 'change "c") "Change"
         "y" (operator 'yank "y") "Yank" ">" (operator 'indent ">") "Indent" "<" (operator 'dedent "<") "Dedent"
         "x" (lambda () (change-made!) (if (selecting?) ((operator 'delete "x")) (count-times! (lambda () (operate! 'delete (head) (min (eol (head)) (+ (head) 1)) #f))))) "Delete Char"
         "X" (lambda () (change-made!) (count-times! (lambda () (let ([p (head)]) (when (> p (bol p)) (operate! 'delete (- p 1) p #f)))))) "Delete Back"
         "D" (lambda () (change-made!) (operate! 'delete (head) (eol (head)) #f)) "Delete To End"
         "C" (lambda () (change-made!) (operate! 'change (head) (eol (head)) #f)) "Change To End"
         "s" (lambda () (change-made!) (operate! 'change (head) (min (eol (head)) (+ (head) (take-count!))) #f)) "Substitute"
         "S" (lambda () (change-made!) (operate-lines! 'change (take-count!))) "Substitute Line"
         "Y" (lambda () (operate-lines! 'yank (take-count!))) "Yank Line"
         "p" (lambda () (paste! #t)) "Paste After" "P" (lambda () (paste! #f)) "Paste Before"
         "J" (lambda () (change-made!) (count-times! (lambda () (run-command 'join)))) "Join"
         "r" (char-keymap 'vim-replace "Replace" replace-char!) "Replace"
         "~" (lambda () (change-made!) (if (selecting?) ((operator 'toggle "~"))
                            (count-times! (lambda () (let ([p (head)])
                                                       (when (< p (eol p))
                                                         (operate! 'toggle p (+ p 1) #f)
                                                         (set-cursors! (list (rest (+ p 1))))))))))
         "Case"
         "u" (lambda () (if (selecting?) ((operator 'lower "u")) (count-times! (lambda () (run-command 'undo))))) "Undo"
         "U" (lambda () (when (selecting?) ((operator 'upper "U")))) "Upper"
         "ctrl+r" (lambda () (count-times! (lambda () (run-command 'redo)))) "Redo"
         ;; In visual mode, an object: v i w selects a word.
         "i" (lambda () (if (selecting?) (enter-layer! inside-keymap "i") (insert-at! 'before))) "Insert"
         "a" (lambda () (if (selecting?) (enter-layer! around-keymap "a") (insert-at! 'after))) "Append"
         "I" (lambda () (insert-at! 'line-start)) "Insert At Start" "A" (lambda () (insert-at! 'line-end)) "Append At End"
         "o" (lambda () (if (selecting?)
                            (let ([a (select-anchor)] [h (head)])
                              (view-local-set! (current-view) 'vi-anchor h)
                              (select-set-head! a))
                            (begin (change-made!) (select-stop!) (run-command 'open-below))))
         "Open Below"
         "O" (lambda () (change-made!) (select-stop!) (run-command 'open-above)) "Open Above"
         "v" (lambda () (visual! 'char)) "Visual" "V" (lambda () (visual! 'line)) "Visual Line"
         "/" (lambda () (vi-search-prompt! 1 (lambda (m) (set-cursors! (list (car m)))))) "Search"
         "?" (lambda () (vi-search-prompt! -1 (lambda (m) (set-cursors! (list (car m)))))) "Search Back"
         "*" (lambda () (search-word! 1)) "Search Word" "#" (lambda () (search-word! -1)) "Search Word Back"
         ":" ex-prompt! "Ex"
         "." (lambda () (repeat-change! (and (count-pending?) (take-count!)))) "Repeat"
         "\"" (char-keymap 'vim-register "Register" register-key!) "Register"
         "q" (lambda () (if (recording) (record-stop!) (enter-layer! record-keymap "q"))) "Record"
         "@" (char-keymap 'vim-play "Play" play-macro!) "Play"
         "ctrl+d" 'scroll-down "Scroll ↓" "ctrl+u" 'scroll-up "Scroll ↑"
         "ctrl+f" 'scroll-down "Page ↓" "ctrl+b" 'scroll-up "Page ↑"
         "enter" (lambda () (vim-move! (list "enter" 'linewise (lambda (p n) (first-nonblank (line-step p n 1)))))) "Next Line")
   ;; ]c and [c: the next and previous change (the jj extension's).
   (let ([next (make-keymap 'vim-next "Next")] [prev (make-keymap 'vim-previous "Previous")])
     (define-key next "c" (lambda () (run-command-if 'jj-next-change)) "Change")
     (define-key prev "c" (lambda () (run-command-if 'jj-previous-change)) "Change")
     (define-key vim-keymap "]" next "Next")
     (define-key vim-keymap "[" prev "Previous"))
   (let ([z (make-keymap 'vim-z "View")] [g (keymap-lookup-target vim-keymap "g")])
     (define-key z "z" 'center "Center")
     (define-key vim-keymap "z" z "View")
     (define-key g "~" (operator 'toggle "~") "Toggle Case")
     (define-key g "u" (operator 'lower "u") "Lower")
     (define-key g "U" (operator 'upper "U") "Upper")
     (define-key g "J" (lambda () (change-made!) (run-command 'join)) "Join"))
   (add-hook! 'escape-hook (lambda () (set! pending-op #f) (set! op-count #f)))
   ;; A cursor a character wide in every buffer: its selection mode CHAR,
   ;; which insert mode goes back to.
   (add-hook! 'buffer-switch-hook
              (lambda (b) (when (vim?) (set-selection-mode! b 'char))))
   (define-key-scheme! 'vim "Vim" "Vim's: motions, operators that take them, counts, visual mode" vim-keymap
     (lambda () (when (current-buffer) (set-selection-mode! (current-buffer) 'char)))
     #f))

  (define (vim?) (let ([s (current-key-scheme)]) (and s (eq? (key-scheme-name s) 'vim)))))
