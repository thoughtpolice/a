;; commands.sls -- the standard commands, keymaps and major modes
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The default bindings are Ki's (https://ki-editor.org), on QWERTY:
;;
;;   movements        j/l left/right  i/k up/down  u/o previous/next
;;                    y/p first/last  m jump  M index  . parent line
;;   selection modes  a LINE  A LINE*  s WORD  S WORD*  w SUBWORD  W CHAR
;;                    d/D NODE  E PARAGRAPH  n local menu (n d to search)
;;   actions          h/; insert before/after  g change (layer: open)
;;                    r delete (layer)  x cut (layer)  c copy (layer: dup)
;;                    v replace (layer: paste)  t swap (layer)  b multi-cursor
;;                    z undo (layer)  Z redo  I join  K break  L/J indent
;;                    F transform  , surround  f extend  enter save
;;                    e buffers (layer)  q selection history  space menu
;;
;; A "layer" is momentary: hold its key and press a movement (r then l
;; deletes rightwards); tap it alone for its default. On terminals without
;; the kitty keyboard protocol, press the layer key twice for the default.
(library (quad commands)
  (export
   ;; selection and movement
   move! select-mode! current-unit move-range
   ;; editing helpers for extensions
   edit-sels! selection-text sels-texts insert-at-cursors! enter-insert!
   exit-insert! gap-between line-indent indent-for-newline
   ;; keymaps
   enclosure-keymap space-keymap local-keymap
   ;; files and lines
   project-files load-init-file! init-file-path goto-line!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor))

  (define (cur) (current-buffer))
  (define (cv) (current-view))


  (define (mode-obj b) (selection-mode-of b))

  ;; ---------------------------------------------------------------------------
  ;; Selections and movement

  (define (sel-range s) (cons (sel-start s) (sel-end s)))
  (define (hull s) (cons (sel-range-start s) (sel-range-end s)))

  (define (current-unit b r)
    ((selection-mode-current (mode-obj b)) b r))

  (define (move-range b r dir)
    ((selection-mode-move (mode-obj b)) b r dir))

  (define (range->sel r) (make-sel (car r) (cdr r)))

  ;; The unit next to range r in direction dir that does not overlap it.
  ;; Movements step from a range's start, so for a range spanning several
  ;; units (an extended selection), forward ones step from its last unit.
  (define (neighbor b r dir)
    (let ([n (move-range b r dir)])
      (if (and n (memq dir '(right next down)) (< (car n) (cdr r)) (> (cdr r) (car r)))
          (let ([m (move-range b (cons (- (cdr r) 1) (cdr r)) dir)])
            (and m (>= (car m) (cdr r)) m))
          n)))

  ;; Move every selection; with extension on, the anchor stays put.
  (define (move! dir)
    (let ([b (cur)])
      (push-selection-history! b)
      (if (memq dir '(up down))
          (unless (view-sticky-col (cv))
            (view-sticky-col-set! (cv) (text-column (buffer-text b) (sel-start (primary)))))
          (view-sticky-col-set! (cv) #f))
      (let ([moved (map (lambda (s)
                          (let ([r (parameterize ([goal-column (view-sticky-col (cv))])
                                     (move-range b (sel-range s) dir))])
                            (cond
                             [(not r) s]
                             [(view-extending? (cv))
                              (make-sel (car r) (cdr r) (or (sel-anchor s) (sel-range s)))]
                             [else (range->sel r)])))
                        (sels-of b))])
        (when (eq? (car moved) (primary)) (message "No ~a ~a" (selection-mode-label (mode-obj b)) dir))
        (set-sels! b moved))))

  (define (select-mode! name)
    (let ([b (cur)])
      (push-selection-history! b)
      (set-selection-mode! b name)
      (view-sticky-col-set! (cv) #f)
      (set-sels! b (map (lambda (s)
                          (let ([r (current-unit b (hull s))])
                            (cond
                             [(not r) s]
                             [(view-extending? (cv)) (make-sel (car r) (cdr r) (or (sel-anchor s) (sel-range s)))]
                             [else (range->sel r)])))
                        (sels-of b)))))

  (define (reselect-current! b)
    (set-sels! b (map (lambda (s) (let ([r (current-unit b (hull s))]) (if r (range->sel r) s)))
                      (sels-of b))))

  (define (selection-text b s) (buffer-substring b (sel-range-start s) (sel-range-end s)))
  (define (sels-texts b) (map (lambda (s) (selection-text b s)) (sels-of b)))

  ;; Edit each selection: (f sel) returns #f to leave it alone, or a list
  ;; (start end text new-sel) where (new-sel start') builds the selection
  ;; from where the replacement text begins after the edit.
  (define (edit-sels! f)
    (let* ([b (cur)]
           [plans (map (lambda (s) (or (f s) (list #f s))) (sels-of b))]
           [edits (filter car plans)])
      (when (pair? edits)
        (let ([starts (buffer-edit! b (map (lambda (p) (list (car p) (cadr p) (caddr p))) edits))])
          (let loop ([ps plans] [starts starts] [acc '()])
            (cond
             [(null? ps) (set-sels! b (reverse acc))]
             [(car (car ps))
              (loop (cdr ps) (cdr starts) (cons ((cadddr (car ps)) (car starts)) acc))]
             [else (loop (cdr ps) starts (cons (cadr (car ps)) acc))]))))
      (view-extending?-set! (cv) #f)))

  ;; The text between a selection and its neighbor in direction dir (right
  ;; or left), or a default gap when there is no neighbor.
  (define (gap-between b s dir)
    (let* ([r (hull s)] [n (neighbor b r dir)]
           [default (if (selection-mode-line-wise? (mode-obj b)) "\n" " ")])
      (cond
       [(not n) default]
       [(and (eq? dir 'right) (>= (car n) (cdr r)))
        (let ([g (buffer-substring b (cdr r) (car n))]) (if (string=? g "") default g))]
       [(and (eq? dir 'left) (<= (cdr n) (car r)))
        (let ([g (buffer-substring b (cdr n) (car r))]) (if (string=? g "") default g))]
       [else default])))

  ;; ---------------------------------------------------------------------------
  ;; Indentation

  (define (line-indent b line)
    (let ([t (buffer-text b)])
      (text-substring t (text-line-start t line) (line-indent-end t line))))

  ;; A major mode can compute indentation itself: indent-function, if set
  ;; (buffer-locally, by the mode's hook), maps a buffer and a position to the
  ;; column a new line there starts at. Otherwise a new line keeps the
  ;; indentation of the one before, plus a level after an opening bracket.
  (define-variable indent-function #f "(buffer position) -> column for a new line, or #f.")

  (define (indent-for-newline b pos)
    (let* ([t (buffer-text b)] [line (text-line-of t pos)] [f (get-var 'indent-function b)])
      (if f
          (make-string (f b pos) #\space)
          (let* ([indent (line-indent b line)]
                 [before (string-trim-right (text-substring t (text-line-start t line) pos))])
            (if (and (> (string-length before) 0)
                     (memv (string-ref before (- (string-length before) 1)) '(#\{ #\( #\[ #\:)))
                (string-append indent (get-var 'indent-unit b))
                indent)))))

  ;; ---------------------------------------------------------------------------
  ;; Insert mode

  (define (enter-insert! where)
    (let ([b (cur)])
      (view-local-set! (cv) 'insert-previous-mode (view-selection-mode (cv)))
      (set-sels! b (map (lambda (s)
                          (let ([p (case where
                                     [(start) (sel-range-start s)]
                                     [(end) (sel-range-end s)]
                                     [else where])])
                            (make-sel p p)))
                        (sels-of b)))
      (view-extending?-set! (cv) #f)
      (view-input-mode-set! (cv) 'insert)
      (run-hooks 'insert-mode-hook b)))

  (define (exit-insert!)
    (let* ([b (cur)]
           [mode (view-local (cv) 'insert-previous-mode 'char)]
           [mode (if (selection-mode-of-text? (find-selection-mode mode)) mode 'char)])
      (view-input-mode-set! (cv) 'normal)
      (buffer-end-group! b)
      (set-selection-mode! b mode)
      ;; Select the unit just before the cursor, where the typing ended,
      ;; looking back past the whitespace typed last.
      (set-sels! b (map (lambda (s)
                          (let* ([t (buffer-text b)]
                                 [p (let loop ([p (- (sel-start s) 1)])
                                      (if (and (> p 0) (char-whitespace? (text-ref t p))) (loop (- p 1)) p))]
                                 [p (max 0 p)]
                                 [r (current-unit b (cons p (min (buffer-length b) (+ p 1))))])
                            (if r (range->sel r) (make-sel p (min (buffer-length b) (+ p 1))))))
                        (sels-of b)))
      (run-hooks 'normal-mode-hook b)))

  (define closers '((#\( . #\)) (#\[ . #\]) (#\{ . #\}) (#\" . #\")))

  ;; Insert text at every cursor; with auto-pairs, an opening bracket gets
  ;; its closer and typing a closer steps over the one already there.
  (define (insert-at-cursors! s)
    (let* ([b (cur)] [t (buffer-text b)] [len (text-length t)]
           [pairs? (and (get-var 'auto-pairs b) (= (string-length s) 1))]
           [c (and pairs? (string-ref s 0))])
      (edit-sels!
       (lambda (sel)
         (let* ([p (sel-start sel)]
                [next (and (< p len) (text-ref t p))])
           (cond
            [(and c next (char=? c next) (memv c '(#\) #\] #\} #\")))
             ;; Step over the closer.
             (list p (+ p 1) s (lambda (np) (make-sel (+ np 1) (+ np 1))))]
            [(and c (assv c closers)
                  (or (not next) (char-whitespace? next) (memv next '(#\) #\] #\}))))
             (list p p (string c (cdr (assv c closers))) (lambda (np) (make-sel (+ np 1) (+ np 1))))]
            [else
             (list p p s (lambda (np) (let ([q (+ np (string-length s))]) (make-sel q q))))]))))))

  (at-load (set-var! 'insert-text-function insert-at-cursors!))

  (define (insert-newline!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (sel)
         (let* ([p (sel-start sel)] [t (buffer-text b)]
                ;; Drop trailing whitespace before the break.
                [ws-start (let loop ([i p]) (if (and (> i (text-line-start t (text-line-of t p)))
                                                     (memv (text-ref t (- i 1)) '(#\space #\tab)))
                                                (loop (- i 1)) i))]
                [indent (indent-for-newline b p)]
                [between (and (< p (text-length t)) (> p 0)
                              (assv (text-ref t (- p 1)) '((#\{ . #\}) (#\( . #\)) (#\[ . #\])))
                              (char=? (text-ref t p) (cdr (assv (text-ref t (- p 1)) '((#\{ . #\}) (#\( . #\)) (#\[ . #\]))))))]
                [text (if (and between (not (syntax-lisp? (major-mode-syntax (buffer-major-mode b)))))
                          (string-append "\n" indent "\n" (line-indent b (text-line-of t p)))
                          (string-append "\n" indent))])
           (list ws-start p text
                 (lambda (np) (let ([q (+ np 1 (string-length indent))]) (make-sel q q)))))))))

  (define (delete-backward!)
    (let* ([b (cur)] [t (buffer-text b)])
      (edit-sels!
       (lambda (sel)
         (let ([p (sel-start sel)])
           (and (> p 0)
                (let* ([prev (text-ref t (- p 1))]
                       [next (and (< p (text-length t)) (text-ref t p))]
                       [pair? (and next (get-var 'auto-pairs b) (assv prev closers)
                                   (char=? next (cdr (assv prev closers))))]
                       ;; In leading indentation, delete back to the previous stop.
                       [line-start (text-line-start t (text-line-of t p))]
                       [unit (string-length (get-var 'indent-unit b))]
                       [in-indent? (and (> unit 1) (char=? prev #\space)
                                        (let loop ([i line-start]) (or (= i p) (and (char=? (text-ref t i) #\space) (loop (+ i 1))))))]
                       [n (if in-indent? (let ([col (- p line-start)]) (max 1 (let ([r (remainder col unit)]) (if (= r 0) unit r)))) 1)])
                  (list (- p n) (if pair? (+ p 1) p) "" (lambda (np) (make-sel np np))))))))))

  (define (delete-forward!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (sel)
         (let ([p (sel-start sel)])
           (and (< p (buffer-length b))
                (list p (+ p 1) "" (lambda (np) (make-sel np np)))))))))

  (define (word-char-at? b i)
    ((syntax-word-char? (major-mode-syntax (buffer-major-mode b))) (text-ref (buffer-text b) i)))

  (define (word-start-before b p)
    (let* ([t (buffer-text b)]
           [p (let loop ([i p]) (if (and (> i 0) (char-whitespace? (text-ref t (- i 1)))) (loop (- i 1)) i))])
      (if (and (> p 0) (word-char-at? b (- p 1)))
          (let loop ([i p]) (if (and (> i 0) (word-char-at? b (- i 1))) (loop (- i 1)) i))
          (max 0 (- p 1)))))

  (define (word-end-after b p)
    (let* ([t (buffer-text b)] [n (text-length t)]
           [p (let loop ([i p]) (if (and (< i n) (char-whitespace? (text-ref t i))) (loop (+ i 1)) i))])
      (if (and (< p n) (word-char-at? b p))
          (let loop ([i p]) (if (and (< i n) (word-char-at? b i)) (loop (+ i 1)) i))
          (min n (+ p 1)))))

  (define (delete-word-backward!)
    (let ([b (cur)])
      (edit-sels! (lambda (sel) (let ([p (sel-start sel)])
                                  (and (> p 0) (list (word-start-before b p) p "" (lambda (np) (make-sel np np)))))))))

  (define (delete-word-forward!)
    (let ([b (cur)])
      (edit-sels! (lambda (sel) (let ([p (sel-start sel)])
                                  (list p (word-end-after b p) "" (lambda (np) (make-sel np np))))))))

  (define (move-cursors! f)
    (let ([b (cur)])
      (set-sels! b (map (lambda (s) (let ([p (f b (sel-start s))]) (make-sel p p))) (sels-of b)))))

  (define (cursor-vertical b p dir)
    (let* ([t (buffer-text b)] [line (text-line-of t p)] [target (+ line dir)])
      (if (<= 0 target (- (text-line-count t) 1))
          (text-pos-at t target (- p (text-line-start t line)))
          p)))

  ;; ---------------------------------------------------------------------------
  ;; Deleting, cutting and changing

  ;; Delete each selection and the gap towards its neighbor in direction
  ;; dir, selecting the neighbor; with no neighbor that way, the other way.
  (define (delete-towards! dir cut?)
    (let ([b (cur)])
      (when cut? (clipboard-push! (sels-texts b)))
      (let ([opposite (case dir [(right) 'left] [(left) 'right] [(next) 'previous] [(previous) 'next] [else 'left])])
        (edit-sels!
         (lambda (s)
           (let* ([r (hull s)]
                  [after (lambda (n) (and n (>= (car n) (cdr r)) n))]
                  [before (lambda (n) (and n (<= (cdr n) (car r)) n))]
                  [fwd? (memq dir '(right next))]
                  [n1 (if fwd? (after (neighbor b r dir)) (before (neighbor b r dir)))]
                  [n2 (and (not n1) (if fwd? (before (neighbor b r opposite)) (after (neighbor b r opposite))))])
             (cond
              [(and n1 fwd?)
               (list (car r) (car n1) "" (lambda (np) (make-sel np (+ np (- (cdr n1) (car n1))))))]
              [n1
               (list (cdr n1) (cdr r) "" (lambda (np) (make-sel (- np (- (cdr n1) (car n1))) np)))]
              [(and n2 (not fwd?))
               (list (car r) (car n2) "" (lambda (np) (make-sel np (+ np (- (cdr n2) (car n2))))))]
              [n2
               (list (cdr n2) (cdr r) "" (lambda (np) (make-sel (- np (- (cdr n2) (car n2))) np)))]
              [else (list (car r) (cdr r) "" (lambda (np) (make-sel np np)))]))))
        (reselect-if-empty! b))))

  (define (reselect-if-empty! b)
    (set-sels! b (map (lambda (s)
                        (if (= (sel-start s) (sel-end s))
                            (let ([r (current-unit b (sel-range s))]) (if r (range->sel r) s))
                            s))
                      (sels-of b))))

  ;; Delete from each selection to the first or last unit of its scope.
  (define (delete-to! dir cut?)
    (let ([b (cur)])
      (edit-sels!
       (lambda (s)
         (let* ([r (hull s)] [n (move-range b r dir)])
           (and n
                (if (eq? dir 'last)
                    (begin (when cut? (clipboard-push! (buffer-substring b (car r) (cdr n))))
                           (list (car r) (max (cdr r) (cdr n)) "" (lambda (np) (make-sel np np))))
                    (begin (when cut? (clipboard-push! (buffer-substring b (car n) (cdr r))))
                           (list (min (car n) (car r)) (cdr r) "" (lambda (np) (make-sel np np)))))))))
      (reselect-if-empty! b)))

  (define (change! cut?)
    (let ([b (cur)])
      (when cut? (clipboard-push! (sels-texts b)))
      (edit-sels! (lambda (s) (list (sel-range-start s) (sel-range-end s) "" (lambda (np) (make-sel np np)))))
      (enter-insert! 'start)))

  ;; ---------------------------------------------------------------------------
  ;; Copying, pasting and duplicating

  ;; The clipboard text for each selection: one piece each when the counts
  ;; match, else the whole entry for all of them.
  (define (clip-for-sels b)
    (let ([e (clipboard-top)] [n (length (sels-of b))])
      (cond
       [(not e) #f]
       [(= (length e) n) e]
       [else (make-list n (string-join e "\n"))])))

  (define (copy!)
    (let ([b (cur)])
      (clipboard-push! (sels-texts b))
      (message "Copied ~a selection~a" (length (sels-of b)) (if (> (length (sels-of b)) 1) "s" ""))))

  (define (replace-with! texts)
    (let ([b (cur)])
      (let ([texts texts])
        (edit-sels!
         (lambda (s)
           (let ([txt (car texts)])
             (set! texts (cdr texts))
             (list (sel-range-start s) (sel-range-end s) txt
                   (lambda (np) (make-sel np (+ np (string-length txt)))))))))))

  ;; Put text beside each selection: where is before, after, gap-before,
  ;; gap-after, above or below. texts holds one string per selection.
  (define (place! texts where)
    (let ([b (cur)] [texts texts])
      (edit-sels!
       (lambda (s)
         (let* ([txt (car texts)] [t (buffer-text b)]
                [rs (sel-range-start s)] [re (sel-range-end s)])
           (set! texts (cdr texts))
           (case where
             [(after) (list re re txt (lambda (np) (make-sel np (+ np (string-length txt)))))]
             [(before) (list rs rs txt (lambda (np) (make-sel np (+ np (string-length txt)))))]
             [(gap-after)
              (let ([gap (gap-between b s 'right)])
                (list re re (string-append gap txt)
                      (lambda (np) (let ([p (+ np (string-length gap))]) (make-sel p (+ p (string-length txt)))))))]
             [(gap-before)
              (let ([gap (gap-between b s 'left)])
                (list rs rs (string-append txt gap)
                      (lambda (np) (make-sel np (+ np (string-length txt))))))]
             [(below)
              (let* ([line (text-line-of t (max rs (- re 1)))] [e (text-line-end t line)]
                     [indent (line-indent b line)]
                     [body (string-trim-right txt)])
                (list e e (string-append "\n" indent body)
                      (lambda (np) (let ([p (+ np 1 (string-length indent))]) (make-sel p (+ p (string-length body)))))))]
             [(above)
              (let* ([line (text-line-of t rs)] [s0 (text-line-start t line)]
                     [indent (line-indent b line)]
                     [body (string-trim-right txt)])
                (list s0 s0 (string-append indent body "\n")
                      (lambda (np) (let ([p (+ np (string-length indent))]) (make-sel p (+ p (string-length body)))))))]))))))

  (define (paste! where)
    (let* ([b (cur)] [clip (clip-for-sels b)])
      (if clip
          (if (eq? where 'replace) (replace-with! clip) (place! clip where))
          (message "The clipboard is empty"))))

  (define (duplicate! where)
    (place! (sels-texts (cur)) where))

  ;; Replace with the previous/next clipboard history entry.
  (define (replace-history! step)
    (let ([e (clipboard-cycle! step)])
      (if e
          (let ([b (cur)])
            (replace-with! (if (= (length e) (length (sels-of b))) e
                               (make-list (length (sels-of b)) (string-join e "\n"))))
            (message "Clipboard history ~a/~a" (+ 1 (list-index (lambda (x) (eq? x e)) (clipboard-history)))
                     (length (clipboard-history))))
          (message "The clipboard is empty"))))

  ;; Replace the selections with the clipboard, which takes their text.
  (define (replace-cut!)
    (let* ([b (cur)] [old (sels-texts b)])
      (paste! 'replace)
      (clipboard-push! old)))

  ;; ---------------------------------------------------------------------------
  ;; Opening, swapping, joining and breaking

  (define (open! where)
    (let ([b (cur)])
      (case where
        [(gap-after gap-before)
         (edit-sels!
          (lambda (s)
            (let ([gap (gap-between b s (if (eq? where 'gap-after) 'right 'left))])
              (if (eq? where 'gap-after)
                  (list (sel-range-end s) (sel-range-end s) gap
                        (lambda (np) (let ([p (+ np (string-length gap))]) (make-sel p p))))
                  (list (sel-range-start s) (sel-range-start s) gap
                        (lambda (np) (make-sel np np)))))))]
        [(below)
         (edit-sels!
          (lambda (s)
            (let* ([t (buffer-text b)] [line (text-line-of t (max (sel-range-start s) (- (sel-range-end s) 1)))]
                   [e (text-line-end t line)] [indent (indent-for-newline b e)])
              (list e e (string-append "\n" indent)
                    (lambda (np) (let ([p (+ np 1 (string-length indent))]) (make-sel p p)))))))]
        [(above)
         (edit-sels!
          (lambda (s)
            (let* ([t (buffer-text b)] [line (text-line-of t (sel-range-start s))]
                   [s0 (text-line-start t line)] [indent (line-indent b line)])
              (list s0 s0 (string-append indent "\n")
                    (lambda (np) (let ([p (+ np (string-length indent))]) (make-sel p p)))))))])
      (enter-insert! 'start)))

  ;; Exchange the primary selection with its neighbor in direction dir.
  (define (swap! dir)
    (let* ([b (cur)] [s (primary)] [r (hull s)] [n (move-range b r dir)])
      (cond
       [(or (not n) (and (< (car n) (cdr r)) (> (cdr n) (car r))))
        (message "Nothing to swap with ~a" dir)]
       [else
        (let* ([a (buffer-substring b (car r) (cdr r))]
               [c (buffer-substring b (car n) (cdr n))]
               [starts (buffer-edit! b (list (list (car r) (cdr r) c) (list (car n) (cdr n) a)))])
          (set-sels! b (list (make-sel (cadr starts) (+ (cadr starts) (string-length a))))))])))

  (define (join-lines!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (s)
         (let* ([t (buffer-text b)] [line (text-line-of t (max (sel-range-start s) (- (sel-range-end s) 1)))])
           (and (< (+ line 1) (text-line-count t))
                (let* ([e (text-line-end t line)]
                       [trim-start (let loop ([i e]) (if (and (> i (text-line-start t line)) (memv (text-ref t (- i 1)) '(#\space #\tab))) (loop (- i 1)) i))]
                       [next (line-indent-end t (+ line 1))]
                       [closing? (and (< next (text-length t)) (memv (text-ref t next) '(#\) #\] #\})))]
                       [sep (if (or closing? (= trim-start (text-line-start t line)) (blank-line? t (+ line 1))) "" " ")])
                  (list trim-start next sep
                        (lambda (np) (make-sel (sel-range-start s) (sel-range-end s)))))))))))

  (define (break-line!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (s)
         (let* ([t (buffer-text b)] [p (sel-range-start s)]
                [ws (let loop ([i p]) (if (and (> i (text-line-start t (text-line-of t p))) (memv (text-ref t (- i 1)) '(#\space #\tab))) (loop (- i 1)) i))]
                [indent (indent-for-newline b ws)]
                [len (sel-length s)])
           (list ws p (string-append "\n" indent)
                 (lambda (np) (let ([q (+ np 1 (string-length indent))]) (make-sel q (+ q len))))))))))

  ;; Indent or dedent every line the selections touch.
  (define (indent-lines! dedent?)
    (let* ([b (cur)] [t (buffer-text b)] [unit (get-var 'indent-unit b)]
           [lines (delete-duplicates*
                   (apply append
                          (map (lambda (s)
                                 (let ([a (text-line-of t (sel-range-start s))]
                                       [z (text-line-of t (max (sel-range-start s) (- (sel-range-end s) 1)))])
                                   (map (lambda (i) (+ a i)) (iota (+ 1 (- z a))))))
                               (sels-of b)))
                   =)]
           [changes (filter-map
                     (lambda (l)
                       (let ([s (text-line-start t l)])
                         (if dedent?
                             (let ([n (let loop ([i 0]) (if (and (< i (string-length unit)) (< (+ s i) (text-length t))
                                                                 (char=? (text-ref t (+ s i)) #\space)) (loop (+ i 1)) i))])
                               (cond [(> n 0) (list s (+ s n) "")]
                                     [(and (< s (text-length t)) (char=? (text-ref t s) #\tab)) (list s (+ s 1) "")]
                                     [else #f]))
                             (and (not (blank-line? t l)) (list s s unit)))))
                     lines)])
      (when (pair? changes)
        (let ([old (sels-of b)] [before (map (lambda (s) (cons (sel-range-start s) (sel-range-end s))) (sels-of b))])
          (buffer-edit! b changes)
          ;; Shift each selection by the changes before it.
          (set-sels! b (map (lambda (r)
                              (let ([shift (lambda (p)
                                             (fold-left (lambda (p c)
                                                          (if (< (car c) p)
                                                              (+ p (- (string-length (caddr c)) (- (min p (cadr c)) (car c))))
                                                              p))
                                                        p (reverse changes)))])
                                (make-sel (shift (car r)) (shift (cdr r)))))
                            before))))))

  ;; ---------------------------------------------------------------------------
  ;; Transforms and surrounds

  (define (words-of s)
    ;; Split on case changes, spaces, underscores and hyphens.
    (let loop ([cs (string->list s)] [word '()] [acc '()] [prev #f])
      (define (flush) (if (null? word) acc (cons (list->string (reverse word)) acc)))
      (cond
       [(null? cs) (reverse (flush))]
       [(memv (car cs) '(#\space #\_ #\- #\tab)) (loop (cdr cs) '() (flush) #f)]
       [(and prev (char-upper-case? (car cs)) (char-lower-case? prev)) (loop (cdr cs) (list (car cs)) (flush) (car cs))]
       [else (loop (cdr cs) (cons (car cs) word) acc (car cs))])))

  (define (capitalize w)
    (if (string=? w "") w (string-append (string (char-upcase (string-ref w 0))) (string-downcase (substring w 1 (string-length w))))))

  (define (case-transform kind)
    (lambda (s)
      (let ([ws (words-of s)])
        (case kind
          [(upper) (string-upcase s)]
          [(lower) (string-downcase s)]
          [(upper-snake) (string-join (map string-upcase ws) "_")]
          [(snake) (string-join (map string-downcase ws) "_")]
          [(kebab) (string-join (map string-downcase ws) "-")]
          [(upper-kebab) (string-join (map capitalize ws) "-")]
          [(pascal) (apply string-append (map capitalize ws))]
          [(camel) (if (null? ws) "" (apply string-append (string-downcase (car ws)) (map capitalize (cdr ws))))]
          [(title) (string-join (map capitalize ws) " ")]))))

  (define (transform-sels! f)
    (let ([b (cur)])
      (edit-sels! (lambda (s)
                    (let ([new (f (selection-text b s))])
                      (list (sel-range-start s) (sel-range-end s) new
                            (lambda (np) (make-sel np (+ np (string-length new))))))))))

  ;; Toggle line comments on the lines the selections touch.
  (define (toggle-comment!)
    (let* ([b (cur)] [t (buffer-text b)]
           [prefix (syntax-line-comment (major-mode-syntax (buffer-major-mode b)))])
      (if (not prefix)
          (message "~a has no line comments" (major-mode-name (buffer-major-mode b)))
          (let* ([trimmed (string-trim-right prefix)]
                 [lines (delete-duplicates*
                         (apply append (map (lambda (s)
                                              (let ([a (text-line-of t (sel-range-start s))]
                                                    [z (text-line-of t (max (sel-range-start s) (- (sel-range-end s) 1)))])
                                                (map (lambda (i) (+ a i)) (iota (+ 1 (- z a))))))
                                            (sels-of b)))
                         =)]
                 [lines (filter (lambda (l) (not (blank-line? t l))) lines)]
                 [commented? (for-all (lambda (l) (string-prefix? trimmed (text-substring t (line-indent-end t l) (text-line-end t l)))) lines)]
                 [col (apply min 1000 (map (lambda (l) (- (line-indent-end t l) (text-line-start t l))) lines))])
            (let ([before (map sel-range-start (sels-of b))])
              (buffer-edit! b (map (lambda (l)
                                     (if commented?
                                         (let* ([s (line-indent-end t l)]
                                                [n (if (string-prefix? prefix (text-substring t s (text-line-end t l)))
                                                       (string-length prefix) (string-length trimmed))])
                                           (list s (+ s n) ""))
                                         (let ([s (+ (text-line-start t l) col)]) (list s s prefix))))
                                   lines))
              ;; Select the lines toggled, so toggling again undoes it.
              (unless (null? lines)
                (let ([t (buffer-text b)])
                  (set-sels! b (list (make-sel (text-line-start t (apply min lines))
                                               (text-line-end t (apply max lines))))))))))))

  ;; Enclosures, for the surround menu: (key open close label).
  (define enclosures
    '(("m" "(" ")" "( )") ("," "[" "]" "[ ]") ("." "{" "}" "{ }") ("/" "<" ">" "< >")
      ("j" "'" "'" "' '") ("k" "\"" "\"" "\" \"") ("l" "`" "`" "` `")))

  (define (enclosure-keymap title proc)
    (let ([km (make-keymap 'enclosure title)])
      (for-each (lambda (e)
                  (define-key km (car e) (lambda () (proc (cadr e) (caddr e))) (cadddr e)))
                enclosures)
      km))

  ;; The innermost (open . close) positions around [s, e) for an enclosure.
  (define (find-enclosure b s e open close)
    (let* ([t (buffer-text b)] [n (text-length t)] [o (string-ref open 0)] [c (string-ref close 0)])
      (if (char=? o c)
          ;; Quotes: the nearest on each side within the line.
          (let* ([line (text-line-of t s)] [ls (text-line-start t line)] [le (text-line-end t line)]
                 [l (let loop ([i (- s 1)]) (cond [(< i ls) #f] [(char=? (text-ref t i) o) i] [else (loop (- i 1))]))]
                 [r (let loop ([i e]) (cond [(>= i le) #f] [(char=? (text-ref t i) c) i] [else (loop (+ i 1))]))])
            (and l r (cons l r)))
          (let ([l (let loop ([i (- s 1)] [depth 0])
                     (cond [(< i 0) #f]
                           [(char=? (text-ref t i) c) (loop (- i 1) (+ depth 1))]
                           [(char=? (text-ref t i) o) (if (= depth 0) i (loop (- i 1) (- depth 1)))]
                           [else (loop (- i 1) depth)]))]
                [r (let loop ([i e] [depth 0])
                     (cond [(>= i n) #f]
                           [(char=? (text-ref t i) o) (loop (+ i 1) (+ depth 1))]
                           [(char=? (text-ref t i) c) (if (= depth 0) i (loop (+ i 1) (- depth 1)))]
                           [else (loop (+ i 1) depth)]))])
            (and l r (cons l r))))))

  (define (surround! open close)
    (edit-sels!
     (lambda (s)
       (let ([txt (selection-text (cur) s)])
         ;; The selection stays on the text inside.
         (list (sel-range-start s) (sel-range-end s) (string-append open txt close)
               (lambda (np) (let ([p (+ np (string-length open))]) (make-sel p (+ p (string-length txt))))))))))

  (define (delete-surround! open close)
    (let ([b (cur)])
      (for-each
       (lambda (s)
         (let ([enc (find-enclosure b (sel-range-start s) (sel-range-end s) open close)])
           (if enc
               (let ([starts (buffer-edit! b (list (list (car enc) (+ 1 (car enc)) "") (list (cdr enc) (+ 1 (cdr enc)) "")))])
                 (set-sels! b (list (make-sel (car starts) (- (cadr starts) 0)))))
               (message "No surrounding ~a~a" open close))))
       (list (primary)))))

  (define (select-surround! open close inside?)
    (let* ([b (cur)] [s (primary)] [enc (find-enclosure b (sel-range-start s) (sel-range-end s) open close)])
      (if enc
          (set-sels! b (list (if inside? (make-sel (+ 1 (car enc)) (cdr enc)) (make-sel (car enc) (+ 1 (cdr enc))))))
          (message "No surrounding ~a~a" open close))))

  (define (change-surround! from-open from-close to-open to-close)
    (let* ([b (cur)] [s (primary)] [enc (find-enclosure b (sel-range-start s) (sel-range-end s) from-open from-close)])
      (if enc
          (let ([starts (buffer-edit! b (list (list (car enc) (+ 1 (car enc)) to-open) (list (cdr enc) (+ 1 (cdr enc)) to-close)))])
            (set-sels! b (list (make-sel (car starts) (+ 1 (cadr starts))))))
          (message "No surrounding ~a~a" from-open from-close))))

  ;; ---------------------------------------------------------------------------
  ;; Multiple cursors

  (define (add-cursor! dir)
    (let* ([b (cur)] [p (primary)] [r (move-range b (hull p) dir)])
      (if r
          (set-sels! b (cons (range->sel r) (sels-of b)))
          (message "No ~a to add a cursor at" dir))))

  (define (cycle-primary! step)
    (let* ([b (cur)] [sels (sort (lambda (x y) (< (sel-start x) (sel-start y))) (sels-of b))]
           [i (list-index (lambda (s) (eq? s (primary))) sels)]
           [n (length sels)])
      (when (> n 1)
        (let ([new (list-ref sels (modulo (+ i step) n))])
          (set-sels! b (cons new (remq new (sels-of b))))))))

  (define (delete-cursor!)
    (let ([b (cur)])
      (when (pair? (cdr (sels-of b)))
        (set-sels! b (cdr (sels-of b))))))

  ;; Every occurrence of the primary selection's text becomes a selection.
  (define (select-all-occurrences!)
    (let* ([b (cur)] [p (primary)] [needle (selection-text b p)] [t (buffer-text b)])
      (if (string=? needle "")
          (message "Nothing selected")
          (let loop ([pos 0] [acc '()])
            (let ([i (text-search-forward t needle pos)])
              (if i
                  (loop (+ i (max 1 (string-length needle))) (cons (make-sel i (+ i (string-length needle))) acc))
                  (let ([all (reverse acc)])
                    (set-sels! b (cons (or (find (lambda (s) (= (sel-start s) (sel-start p))) all) p)
                                       all))
                    (message "~a occurrences" (length all)))))))))

  ;; ---------------------------------------------------------------------------
  ;; Jumping, searching and the index

  (define jump-alphabet "fjdkslaghrueiwoqptyvbcnmxz")

  (define (show-jumps! k)
    (let* ([b (cur)] [g (view-geometry)]
           [first (view-top (cv))]
           [last (min (- (text-line-count (buffer-text b)) 1) (+ first (if g (list-ref g 2) 20) -1))]
           [units ((selection-mode-visible (mode-obj b)) b first last)]
           [n (string-length jump-alphabet)]
           [units (take units (* n n))]
           [labels (if (<= (length units) n)
                       (map (lambda (i) (string (string-ref jump-alphabet i))) (iota (length units)))
                       (map (lambda (i) (string (string-ref jump-alphabet (quotient i n))
                                                (string-ref jump-alphabet (remainder i n))))
                            (iota (length units))))])
      (if (null? units)
          (message "Nothing to jump to")
          (jump-labels-set! (map cons labels units) k))))

  (define (jump!)
    (show-jumps!
     (lambda (r)
       (let ([b (cur)])
         (push-selection-history! b)
         (set-sels! b (list (if (view-extending? (cv))
                                (make-sel (car r) (cdr r) (or (sel-anchor (primary)) (sel-range (primary))))
                                (range->sel r))))))))

  (define (search! pattern)
    (let ([b (cur)])
      (search-pattern-set! b pattern)
      (buffer-local-set! b 'last-search pattern)
      (push-selection-history! b)
      (set-selection-mode! b 'search)
      (let ([r (current-unit b (sel-range (primary)))])
        (if r
            (set-sels! b (list (range->sel r)))
            (message-error "No match for ~s" pattern)))))

  (define (search-prompt!)
    (let* ([b (cur)] [origin (sels-of b)] [mode (view-selection-mode (cv))])
      (open-prompt!
       (make-prompt "search:" "" #f
                    (lambda (s) (if (string=? s "")
                                    (begin (set-sels! b origin) (set-selection-mode! b mode))
                                    (search! s)))
                    ;; Incremental: show the first match as you type.
                    (lambda (s)
                      (when (> (string-length s) 0)
                        (search-pattern-set! b s)
                        (let ([r ((selection-mode-current (find-selection-mode 'search)) b (sel-range (car origin)))])
                          (when r (set-sels! b (list (range->sel r)))))))
                    'line))))

  (define (goto-line! n)
    (let* ([b (cur)] [t (buffer-text b)] [line (clamp (- n 1) 0 (- (text-line-count t) 1))])
      (push-selection-history! b)
      (let ([r (current-unit b (cons (line-indent-end t line) (line-indent-end t line)))])
        (set-sels! b (list (if r (range->sel r) (make-sel (text-line-start t line) (text-line-start t line))))))))

  (define (parent-line!)
    (let* ([b (cur)] [t (buffer-text b)] [line (text-line-of t (sel-range-start (primary)))]
           [indent (lambda (l) (- (line-indent-end t l) (text-line-start t l)))]
           [mine (indent line)])
      (let loop ([l (- line 1)])
        (cond
         [(< l 0) (message "No parent line")]
         [(and (not (blank-line? t l)) (< (indent l) mine))
          (push-selection-history! b)
          (let ([r (current-unit b (cons (line-indent-end t l) (line-indent-end t l)))])
            (when r (set-sels! b (list (range->sel r)))))]
         [else (loop (- l 1))]))))

  ;; ---------------------------------------------------------------------------
  ;; Files, buffers and pickers

  (define ignored-dirs '(".git" ".jj" ".hg" "buck-out" "node_modules" "target" "_build" ".direnv" "zig-cache" ".zig-cache"))

  ;; Files under dir, relative to it, breadth first, at most `limit`.
  (define (project-files dir limit)
    (let loop ([queue (list "")] [acc '()] [n 0])
      (if (or (null? queue) (>= n limit))
          (reverse acc)
          (let* ([rel (car queue)]
                 [abs (if (string=? rel "") dir (path-join dir rel))]
                 [entries (guard (e [#t '()]) (sort-strings (directory-list abs)))])
            (let scan ([es entries] [queue (cdr queue)] [acc acc] [n n])
              (if (null? es)
                  (loop queue acc n)
                  (let* ([name (car es)] [r (if (string=? rel "") name (path-join rel name))]
                         [full (path-join dir r)])
                    (cond
                     [(member name ignored-dirs) (scan (cdr es) queue acc n)]
                     [(guard (e [#t #f]) (file-directory? full)) (scan (cdr es) (append queue (list r)) acc n)]
                     [else (scan (cdr es) queue (cons r acc) (+ n 1))]))))))))

  (define (visit! path)
    (let ([b (open-file! path)])
      (push-selection-history! (cur))
      (switch-to-buffer! b)))

  (define (file-picker! dir)
    (let ([files (project-files dir 50000)])
      (pick (format "Files in ~a" (path-basename (string-trim-right dir)))
            (map (lambda (f) (cons f (path-join dir f))) files)
            visit!)))

  ;; A directory browser: directories open into themselves.
  (define (explorer! dir)
    (let* ([entries (guard (e [#t '()]) (sort-strings (directory-list dir)))]
           [items (cons (cons "../" (path-dirname dir))
                        (map (lambda (n)
                               (let ([full (path-join dir n)])
                                 (if (guard (e [#t #f]) (file-directory? full))
                                     (cons (string-append n "/") full)
                                     (cons n full))))
                             entries))])
      (pick (string-append "Explore " dir) items
            (lambda (path)
              (if (file-directory? path) (explorer! path) (visit! path))))))

  (define (buffer-picker!)
    (pick "Buffers"
          (map (lambda (b) (cons (string-append (buffer-name b) (if (buffer-modified? b) " ●" "")
                                                (if (buffer-path b) (string-append "  " (buffer-display-name b)) ""))
                                 b))
               (buffers))
          switch-to-buffer!))

  (define (command-palette!)
    (pick "Command"
          (map (lambda (n)
                 (let ([doc (command-doc (find-command n))])
                   (cons (string-append (symbol->string n) (if (string=? doc "") "" (string-append "  — " doc))) n)))
               (command-names))
          run-command))

  (define (theme-picker!)
    (pick "Theme" (map (lambda (n) (cons (symbol->string n) n)) (theme-names))
          (lambda (n) (load-theme! n) (message "Theme ~a" n))))

  (define (help!)
    (pick "Keys (normal mode)"
          (apply append
                 (map (lambda (e)
                        (let ([t (binding-target (cdr e))])
                          (if (keymap? t)
                              (map (lambda (e2)
                                     (cons (format "~a ~a   ~a" (car e) (car e2) (binding-label (cdr e2)))
                                           (binding-target (cdr e2))))
                                   (keymap-entries t))
                              (list (cons (format "~a   ~a" (car e) (binding-label (cdr e))) t)))))
                      (keymap-entries normal-keymap)))
          (lambda (t) (unless (keymap? t) (run-command t)))))

  (define (open-path-prompt!)
    (read-string-prompt "open:" (path-join (current-directory) "")
                        (lambda (p) (unless (string=? p "") (visit! p)))))

  (define (save! force?)
    (let ([b (cur)])
      (cond
       [(not (buffer-path b)) (save-as!)]
       [(or force? (buffer-modified? b)) (save-buffer! b)]
       [else (message "No changes to save")])))

  (define (save-as!)
    (let ([b (cur)])
      (read-string-prompt "save as:" (or (buffer-path b) (path-join (current-directory) ""))
                          (lambda (p) (unless (string=? p "")
                                        (save-buffer! b (if (string-prefix? "/" p) p (path-join (current-directory) p)))
                                        (buffer-name-set! b (path-basename p)))))))

  (define (modified-file-buffers) (filter (lambda (b) (and (buffer-path b) (buffer-modified? b))) (buffers)))

  ;; Is this client the editor's last? Then quitting stops the editor.
  (define (last-client?)
    (and (not (editor-daemon?)) (not (exists (lambda (c) (not (eq? c (current-client)))) (clients)))))

  ;; Stop the editor (for every client), asking first about unsaved files.
  (define (stop-editor!)
    (let ([dirty (modified-file-buffers)])
      (if (null? dirty)
          (editor-quit!)
          (read-string-prompt (format "~a unsaved buffer~a; quit anyway? (y/n)" (length dirty)
                                      (if (> (length dirty) 1) "s" ""))
                              (lambda (a) (when (member a '("y" "yes")) (editor-quit!)))))))

  ;; Leave: this client goes, and the editor with it if it was the last.
  (define (safe-quit!)
    (if (last-client?) (stop-editor!) (client-quit! (current-client))))

  (define (reload-buffer! b)
    (when (and (buffer-path b) (file-exists? (buffer-path b)))
      (let ([sels (sels-of b)])
        (buffer-replace-all! b (read-file-string (buffer-path b)))
        (buffer-mark-saved! b)
        (buffer-local-set! b 'mtime (file-modification-time (buffer-path b)))
        (set-sels! b sels))))

  (define (close-buffer!)
    (let ([b (cur)])
      (if (and (buffer-path b) (buffer-modified? b))
          (read-string-prompt "Buffer has unsaved changes; close anyway? (y/n)"
                              (lambda (a) (when (member a '("y" "yes")) (kill-buffer! b))))
          (kill-buffer! b))))

  (define (cycle-buffer! step)
    (let* ([bs (buffers)] [i (list-index (lambda (b) (eq? b (cur))) bs)])
      (when (> (length bs) 1)
        (switch-to-buffer! (list-ref bs (modulo (+ i step) (length bs)))))))

  ;; The buffer this client saw before the current one.
  (define (alternate-buffer!)
    (let ([others (filter (lambda (b) (not (eq? b (cur)))) (buffers))])
      (unless (null? others)
        (switch-to-buffer!
         (car (sort (lambda (a b) (> (view-last-seen (view-of (current-client) a))
                                     (view-last-seen (view-of (current-client) b))))
                    others))))))

  ;; ---------------------------------------------------------------------------
  ;; Evaluation and the shell

  (define (show-result v)
    (unless (eq? v (void))
      (message "⇒ ~a" (let ([s (with-output-to-string (lambda () (write v)))])
                        (if (> (string-length s) 400) (string-append (substring s 0 400) "…") s)))))

  (define (eval-expression!)
    (read-string-prompt "eval:" (lambda (s) (unless (string=? s "") (show-result (eval-string s))))))

  (define (eval-selection!)
    (show-result (eval-string (selection-text (cur) (primary)))))

  (define (eval-buffer!)
    (eval-string (buffer-string (cur)))
    (message "Evaluated ~a" (buffer-name (cur))))

  ;; Pipe each selection through a shell command, replacing it with the
  ;; output, as Kakoune's | does.
  (define (pipe-selections!)
    (read-string-prompt "pipe:"
                        (lambda (cmd)
                          (unless (string=? cmd "")
                            (replace-with! (map (lambda (txt) (run-shell cmd txt)) (sels-texts (cur))))))))

  (define (run-shell cmd input)
    (let-values ([(to from err pid) (open-process-ports cmd (buffer-mode block)
                                                        (make-transcoder (utf-8-codec) (eol-style none)))])
      (put-string to input)
      (close-port to)
      (let ([out (get-string-all from)])
        (close-port from)
        (close-port err)
        (if (eof-object? out) "" out))))

  ;; Suspending is the client's to do: a terminal stops its process.
  (define (suspend!) (client-send! (current-client) '("suspend")))

  ;; ---------------------------------------------------------------------------
  ;; Scrolling

  (define (scroll! lines)
    (let* ([b (cur)] [n (text-line-count (buffer-text b))])
      (view-top-set! (cv) (clamp (+ (view-top (cv)) lines) 0 (max 0 (- n 1))))
      (view-local-set! (cv) 'free-scroll #t)))

  (define (page) (let ([g (view-geometry)]) (if g (list-ref g 2) 20)))

  ;; Page up and down move the selection by the page too.
  (define (scroll-page! dir)
    (let* ([b (cur)] [t (buffer-text b)] [lines (* dir (quotient (page) 2))]
           [line (clamp (+ (text-line-of t (sel-range-start (primary))) lines) 0 (- (text-line-count t) 1))])
      (scroll! lines)
      (view-local-set! (cv) 'free-scroll #f)
      (let ([r (current-unit b (cons (line-indent-end t line) (line-indent-end t line)))])
        (when r (set-sels! b (list (range->sel r)))))))

  (define (center-view!)
    (let* ([b (cur)] [line (text-line-of (buffer-text b) (sel-range-start (primary)))])
      (view-top-set! (cv) (max 0 (- line (quotient (page) 2))))
      (view-local-set! (cv) 'free-scroll #t)))

  ;; ---------------------------------------------------------------------------
  ;; The mouse
  ;;
  ;; Click selects the unit of the current selection mode under the pointer;
  ;; double-click selects a word and triple-click a line (switching modes);
  ;; dragging extends; shift-click extends to the pointer; alt- or
  ;; ctrl-click adds a cursor; middle-click pastes the primary selection;
  ;; the wheel scrolls.

  (define last-click #f)   ; (time pos count)
  (define drag-anchor #f)

  (define (unit-at b pos)
    (or (current-unit b (cons pos (min (buffer-length b) (+ pos 1)))) (cons pos pos)))

  (define (on-mouse ev)
    (let* ([b (cur)] [kind (mouse-event-kind ev)]
           [pos (screen->position (mouse-event-row ev) (mouse-event-col ev))])
      (case kind
        [(scroll-up) (scroll! -3)]
        [(scroll-down) (scroll! 3)]
        [(press)
         (when (and pos (not (current-prompt)))
           (exit-layer!)
           (case (mouse-event-button ev)
             [(0)
              (let* ([now (real-time)]
                     [count (if (and last-click (< (- now (car last-click)) 400) (= pos (cadr last-click)))
                                (+ 1 (caddr last-click)) 1)])
                (set! last-click (list now pos count))
                (when (eq? (view-input-mode (cv)) 'insert) (exit-insert!))
                (push-selection-history! b)
                (cond
                 [(logtest (mouse-event-mods ev) mod-shift)
                  (let ([r (unit-at b pos)] [p (primary)])
                    (set-sels! b (cons (make-sel (car r) (cdr r) (or (sel-anchor p) (sel-range p))) (cdr (sels-of b)))))]
                 [(logtest (mouse-event-mods ev) (logior mod-alt mod-ctrl))
                  (let ([r (unit-at b pos)]) (set-sels! b (cons (range->sel r) (sels-of b))))]
                 [else
                  (case (min count 3)
                    [(2) (set-selection-mode! b 'word)]
                    [(3) (set-selection-mode! b 'line)]
                    [else (void)])
                  (let ([r (unit-at b pos)])
                    (set! drag-anchor r)
                    (set-sels! b (list (range->sel r))))]))]
             [(1)
              (let ([s (primary-selection)])
                (when (> (string-length s) 0)
                  (run-command (lambda ()
                                 (let ([starts (buffer-edit! b (list (list pos pos s)))])
                                   (set-sels! b (list (make-sel (car starts) (+ (car starts) (string-length s))))))))))]
             [else (void)]))]
        [(drag)
         (when (and pos drag-anchor (= (mouse-event-button ev) 0))
           (let ([r (unit-at b pos)])
             (set-sels! b (list (make-sel (car r) (cdr r) drag-anchor)))
             (view-local-set! (cv) 'free-scroll #f)))]
        [(release)
         (when drag-anchor
           (let ([p (primary)])
             (when (sel-anchor p)
               (set-sels! b (list (sel-collapse p)))
               (primary-selection-set! (selection-text b (primary)))))
           (set! drag-anchor #f))])))

  (at-load (add-hook! 'mouse-hook on-mouse))

  ;; Pasting from the terminal (bracketed paste): typed in insert mode, and
  ;; in normal mode it replaces the selections.
  (at-load (add-hook! 'paste-hook
             (lambda (text)
               (run-command
                (lambda ()
                  (let ([b (cur)])
                    (if (eq? (view-input-mode (cv)) 'insert)
                        (edit-sels! (lambda (s) (list (sel-start s) (sel-start s) text
                                                      (lambda (np) (let ([q (+ np (string-length text))]) (make-sel q q))))))
                        (replace-with! (make-list (length (sels-of b)) text)))))))))

  ;; Clients that show a title (a terminal's, a window's) show the buffer's,
  ;; and learn the working directory, for new terminal tabs.
  (define (send-title! c b)
    (when (client-has? c "title")
      (client-send! c (list "title" (string-append "quad — " (buffer-name b))))))

  (at-load
   (add-hook! 'client-attach-hook
              (lambda (c)
                (client-send! c (list "cwd" (current-directory)))
                (let ([v (client-view c)]) (when v (send-title! c (view-buffer v))))))
   (add-hook! 'buffer-switch-hook (lambda (b) (send-title! (current-client) b))))

    ;; Coming back to the terminal: reload files changed on disk behind
  ;; unmodified buffers, and warn about modified ones.
  (at-load (add-hook! 'focus-in-hook
             (lambda ()
               (for-each
                (lambda (b)
                  (let ([p (buffer-path b)])
                    (when (and p (file-exists? p) (buffer-local b 'mtime #f)
                               (not (equal? (file-modification-time p) (buffer-local b 'mtime #f))))
                      (if (buffer-modified? b)
                          (message-error "~a changed on disk; space j d reloads it" (buffer-name b))
                          (begin (reload-buffer! b) (message "Reloaded ~a" (buffer-name b)))))))
                (buffers)))))

  ;; ---------------------------------------------------------------------------
  ;; Command definitions

  (define-syntax defcmd
    (syntax-rules ()
      [(_ name doc body ...) (at-load (define-command 'name doc (lambda () body ...)))]))

  (defcmd move-left "Previous unit" (move! 'left))
  (defcmd move-right "Next unit" (move! 'right))
  (defcmd move-up "Unit above" (move! 'up))
  (defcmd move-down "Unit below" (move! 'down))
  (defcmd move-previous "Previous unit, of any kind" (move! 'previous))
  (defcmd move-next "Next unit, of any kind" (move! 'next))
  (defcmd move-first "First unit" (move! 'first))
  (defcmd move-last "Last unit" (move! 'last))
  (defcmd jump "Jump to a labelled unit" (jump!))
  (defcmd goto-index "Go to a line by number"
    (read-string-prompt "line:" (lambda (s) (let ([n (string->number s)]) (when n (goto-line! n))))))
  (defcmd parent-line "Nearest less-indented line above" (parent-line!))

  (defcmd select-line "LINE mode" (select-mode! 'line))
  (defcmd select-line-full "LINE* mode: lines with their newlines" (select-mode! 'line-full))
  (defcmd select-node "NODE mode: syntax nodes" (select-mode! 'node))
  (defcmd select-word "WORD mode" (select-mode! 'word))
  (defcmd select-big-word "WORD* mode: runs of non-blanks" (select-mode! 'big-word))
  (defcmd select-subword "SUBWORD mode" (select-mode! 'subword))
  (defcmd select-char "CHAR mode" (select-mode! 'char))
  (defcmd select-paragraph "PARAGRAPH mode" (select-mode! 'paragraph))
  (defcmd select-all "Select the whole buffer"
    (let ([b (cur)]) (view-extending?-set! (cv) #f) (set-sels! b (list (make-sel 0 (buffer-length b))))))
  (defcmd extend "Extend selections with the next movements"
    (let ([b (cur)])
      (if (view-extending? (cv))
          (run-command 'select-all)
          (view-extending?-set! (cv) #t))))
  (defcmd swap-anchor "Swap the extension anchor and the moving end"
    (let ([b (cur)])
      (set-sels! b (map (lambda (s) (if (sel-anchor s)
                                        (make-sel (car (sel-anchor s)) (cdr (sel-anchor s)) (sel-range s))
                                        s))
                        (sels-of b)))))
  (defcmd swap-cursor "Put the cursor at the other end of the selections"
    (view-cursor-start?-set! (cv) (not (view-cursor-start? (cv)))))
  (defcmd selection-back "Previous selection" (unless (selection-history-back! (cur)) (message "No older selection")))
  (defcmd selection-forward "Next selection" (unless (selection-history-forward! (cur)) (message "No newer selection")))

  (defcmd search "Search, selecting matches" (search-prompt!))
  (defcmd search-this "Search for the selected text" (search! (selection-text (cur) (primary))))
  (defcmd search-repeat "Search for the last pattern again"
    (let ([p (buffer-local (cur) 'last-search #f)]) (if p (search! p) (message "No previous search"))))

  (defcmd insert-before "Insert before the selections" (enter-insert! 'start))
  (defcmd insert-after "Insert after the selections" (enter-insert! 'end))
  (defcmd change "Replace the selections by typing" (change! #f))
  (defcmd change-cut "Cut the selections, then type" (change! #t))
  (defcmd open-after "Insert a gap after the selections, and type" (open! 'gap-after))
  (defcmd open-before "Insert a gap before the selections, and type" (open! 'gap-before))
  (defcmd open-below "Open a line below" (open! 'below))
  (defcmd open-above "Open a line above" (open! 'above))

  (defcmd delete-one "Delete the selections" (delete-towards! 'right #f))
  (defcmd delete-right "Delete, selecting the next unit" (delete-towards! 'right #f))
  (defcmd delete-left "Delete, selecting the previous unit" (delete-towards! 'left #f))
  (defcmd delete-next "Delete, selecting the next unit of any kind" (delete-towards! 'next #f))
  (defcmd delete-previous "Delete, selecting the previous unit of any kind" (delete-towards! 'previous #f))
  (defcmd delete-to-first "Delete back to the first unit" (delete-to! 'first #f))
  (defcmd delete-to-last "Delete up to the last unit" (delete-to! 'last #f))
  (defcmd cut-one "Cut the selections" (delete-towards! 'right #t))
  (defcmd cut-right "Cut, selecting the next unit" (delete-towards! 'right #t))
  (defcmd cut-left "Cut, selecting the previous unit" (delete-towards! 'left #t))
  (defcmd cut-next "Cut, selecting the next unit of any kind" (delete-towards! 'next #t))
  (defcmd cut-previous "Cut, selecting the previous unit of any kind" (delete-towards! 'previous #t))
  (defcmd cut-to-first "Cut back to the first unit" (delete-to! 'first #t))
  (defcmd cut-to-last "Cut up to the last unit" (delete-to! 'last #t))

  (defcmd copy "Copy the selections" (copy!))
  (defcmd replace "Replace the selections with the clipboard" (paste! 'replace))
  (defcmd paste-after "Paste after the selections" (paste! 'after))
  (defcmd paste-before "Paste before the selections" (paste! 'before))
  (defcmd paste-gap-after "Paste after, with a gap" (paste! 'gap-after))
  (defcmd paste-gap-before "Paste before, with a gap" (paste! 'gap-before))
  (defcmd paste-below "Paste on a new line below" (paste! 'below))
  (defcmd paste-above "Paste on a new line above" (paste! 'above))
  (defcmd replace-history-older "Replace with the older clipboard entry" (replace-history! 1))
  (defcmd replace-history-newer "Replace with the newer clipboard entry" (replace-history! -1))
  (defcmd replace-cut "Replace with the clipboard, which takes the selections" (replace-cut!))
  (defcmd paste-system "Paste the system clipboard, asking the terminal"
    (system-clipboard-request! (lambda (text) (clipboard-push! text) (paste! 'replace))))
  (defcmd duplicate-after "Duplicate after" (duplicate! 'after))
  (defcmd duplicate-before "Duplicate before" (duplicate! 'before))
  (defcmd duplicate-gap-after "Duplicate after, with a gap" (duplicate! 'gap-after))
  (defcmd duplicate-gap-before "Duplicate before, with a gap" (duplicate! 'gap-before))
  (defcmd duplicate-below "Duplicate on a line below" (duplicate! 'below))
  (defcmd duplicate-above "Duplicate on a line above" (duplicate! 'above))

  (defcmd undo "Undo the last change" (unless (buffer-undo! (cur) #f) (message "Nothing to undo")))
  (defcmd redo "Redo the last undone change" (unless (buffer-redo! (cur)) (message "Nothing to redo")))
  (defcmd undo-fine "Undo one edit" (unless (buffer-undo! (cur) #t) (message "Nothing to undo")))
  (defcmd redo-fine "Redo one edit" (unless (buffer-redo! (cur)) (message "Nothing to redo")))

  (at-load (for-each (lambda (d)
              (define-command (string->symbol (format "swap-~a" d)) (format "Swap with the ~a unit" d)
                (lambda () (swap! d)))
              (define-command (string->symbol (format "add-cursor-~a" d)) (format "Add a cursor at the ~a unit" d)
                (lambda () (add-cursor! d))))
            '(left right up down previous next first last)))
  (defcmd cursor-previous "Make the previous cursor primary" (cycle-primary! -1))
  (defcmd cursor-next "Make the next cursor primary" (cycle-primary! 1))
  (defcmd cursor-delete "Remove the primary cursor" (delete-cursor!))
  (defcmd select-all-occurrences "A cursor at every occurrence of the selection" (select-all-occurrences!))

  (defcmd join "Join the next line onto this one" (join-lines!))
  (defcmd break "Break the line before the selections" (break-line!))
  (defcmd indent "Indent the selected lines" (indent-lines! #f))
  (defcmd dedent "Dedent the selected lines" (indent-lines! #t))
  (defcmd toggle-comment "Toggle line comments" (toggle-comment!))
  (at-load (for-each (lambda (k)
              (define-command (string->symbol (format "case-~a" k)) (format "Convert to ~a case" k)
                (lambda () (transform-sels! (case-transform k)))))
            '(upper lower upper-snake snake kebab upper-kebab pascal camel title)))

  (defcmd save "Save the buffer" (save! #f))
  (defcmd save-force "Save the buffer, even unchanged" (save! #t))
  (defcmd save-as "Save the buffer to another file" (save-as!))
  (defcmd save-all "Save every modified buffer" (for-each save-buffer! (modified-file-buffers)))
  (defcmd quit "Quit, asking about unsaved changes" (safe-quit!))
  (defcmd quit-no-save "Quit, discarding changes" (client-quit! (current-client)))
  (defcmd kill-server "Stop the editor, for every client, asking about unsaved changes" (stop-editor!))
  (defcmd list-clients "The clients connected to this editor"
    (pick "Clients"
          (map (lambda (c)
                 (cons (format "~a ~a  ~ax~a  ~a~a" (client-id c) (client-name c) (client-cols c) (client-rows c)
                               (let ([v (client-view c)]) (if v (buffer-name (view-buffer v)) "-"))
                               (if (eq? c (current-client)) "  (this one)" ""))
                       c))
               (clients))
          (lambda (c) (void))))
  (defcmd reload "Reload the buffer from its file" (reload-buffer! (cur)) (message "Reloaded"))
  (defcmd reload-all "Reload every buffer from its file" (for-each reload-buffer! (buffers)))
  (defcmd change-directory "Change the working directory"
    (read-string-prompt "cd:" (path-join (current-directory) "")
                        (lambda (d) (current-directory d) (message "Now in ~a" (current-directory)))))
  (defcmd open-file "Pick a file in the working directory" (file-picker! (current-directory)))
  (defcmd open-path "Open a file by path" (open-path-prompt!))
  (defcmd explore "Browse the file system" (explorer! (current-directory)))
  (defcmd switch-buffer "Pick a buffer" (buffer-picker!))
  (defcmd buffer-next "Next buffer" (cycle-buffer! 1))
  (defcmd buffer-previous "Previous buffer" (cycle-buffer! -1))
  (defcmd buffer-close "Close the buffer" (close-buffer!))
  (defcmd buffer-alternate "The previously seen buffer" (alternate-buffer!))
  (defcmd scratch "The *scratch* buffer, for Scheme"
    (switch-to-buffer! (or (find-buffer-named "*scratch*")
                           (new-buffer! "*scratch*" ";; Scheme scratch: select a form (d) and press space l e.\n\n"
                                        (or (find-major-mode 'scheme) fundamental-mode)))))
  (defcmd messages "The *Messages* buffer" (switch-to-buffer! (messages-buffer)))
  (defcmd command-palette "Run a command by name" (command-palette!))
  (defcmd pick-theme "Choose a theme" (theme-picker!))
  (defcmd help "Every key binding" (help!))
  (defcmd eval-expression "Evaluate a Scheme expression" (eval-expression!))
  (defcmd eval-selection "Evaluate the selection as Scheme" (eval-selection!))
  (defcmd eval-buffer "Evaluate the buffer as Scheme" (eval-buffer!))
  (defcmd pipe "Pipe the selections through a shell command" (pipe-selections!))
  (defcmd suspend "Suspend to the shell" (suspend!))
  (defcmd scroll-down "Scroll half a page down" (scroll-page! 1))
  (defcmd scroll-up "Scroll half a page up" (scroll-page! -1))
  (defcmd center "Center the view on the selection" (center-view!))
  (defcmd toggle-line-numbers "Cycle absolute, relative and no line numbers"
    (set-var! 'line-numbers (case (get-var 'line-numbers #f) [(absolute) 'relative] [(relative) #f] [else 'absolute])))
  (defcmd toggle-whitespace "Show or hide whitespace" (set-var! 'show-whitespace (not (get-var 'show-whitespace #f))))
  (defcmd escape "Hide the popup, else back to one selection, and stop extending"
    (let ([b (cur)])
      (jump-labels-set! '() #f)
      (cond
       [(current-popup) (hide-popup!)]
       [(view-extending? (cv))
        (view-extending?-set! (cv) #f)
        (set-sels! b (map sel-collapse (sels-of b)))]
       [(pair? (cdr (sels-of b))) (set-sels! b (list (primary)))]
       [else (clear-message!)])))

  ;; Insert mode.
  (defcmd exit-insert "Back to normal mode" (exit-insert!))
  (defcmd newline "Insert a line break, indenting" (insert-newline!))
  (defcmd delete-backward "Delete the character before the cursor" (delete-backward!))
  (defcmd delete-forward "Delete the character after the cursor" (delete-forward!))
  (defcmd delete-word-backward "Delete the word before the cursor" (delete-word-backward!))
  (defcmd delete-word-forward "Delete the word after the cursor" (delete-word-forward!))
  (defcmd insert-tab "Indent" (insert-at-cursors! (get-var 'indent-unit (cur))))
  (defcmd cursor-left "Cursor left" (move-cursors! (lambda (b p) (max 0 (- p 1)))))
  (defcmd cursor-right "Cursor right" (move-cursors! (lambda (b p) (min (buffer-length b) (+ p 1)))))
  (defcmd cursor-up "Cursor up" (move-cursors! (lambda (b p) (cursor-vertical b p -1))))
  (defcmd cursor-down "Cursor down" (move-cursors! (lambda (b p) (cursor-vertical b p 1))))
  (defcmd cursor-word-left "Cursor to the previous word" (move-cursors! word-start-before))
  (defcmd cursor-word-right "Cursor to the next word" (move-cursors! word-end-after))
  (defcmd cursor-line-start "Cursor to the line start"
    (move-cursors! (lambda (b p) (let ([t (buffer-text b)])
                                   (let ([i (line-indent-end t (text-line-of t p))])
                                     (if (= p i) (text-line-start t (text-line-of t p)) i))))))
  (defcmd cursor-line-end "Cursor to the line end"
    (move-cursors! (lambda (b p) (let ([t (buffer-text b)]) (text-line-end t (text-line-of t p))))))
  (defcmd kill-line "Delete to the line end"
    (let ([b (cur)])
      (edit-sels! (lambda (s) (let* ([t (buffer-text b)] [p (sel-start s)] [e (text-line-end t (text-line-of t p))])
                                (list p (if (= p e) (min (text-length t) (+ e 1)) e) "" (lambda (np) (make-sel np np))))))))
  (defcmd kill-line-backward "Delete to the line start"
    (let ([b (cur)])
      (edit-sels! (lambda (s) (let* ([t (buffer-text b)] [p (sel-start s)])
                                (list (text-line-start t (text-line-of t p)) p "" (lambda (np) (make-sel np np))))))))

  ;; Prompts.
  (define (prompt-edit! f)
    (let ([p (current-prompt)])
      (when p
        (let-values ([(in c) (f (prompt-input p) (prompt-cursor p))])
          (prompt-input-set! p in)
          (prompt-cursor-set! p (clamp c 0 (string-length in)))
          (prompt-index-set! p 0)
          (prompt-refresh! p)))))
  (define (prompt-move! step)
    (let ([p (current-prompt)])
      (when (and p (pair? (prompt-items p)))
        (prompt-index-set! p (modulo (+ (prompt-index p) step) (length (prompt-items p)))))))
  (defcmd prompt-accept "Accept the input" (let ([p (current-prompt)]) (when p (prompt-accept! p))))
  (defcmd prompt-cancel "Cancel" (close-prompt!))
  (defcmd prompt-delete-backward "Delete before the cursor"
    (prompt-edit! (lambda (in c) (if (= c 0) (values in c)
                                     (values (string-append (substring in 0 (- c 1)) (substring in c (string-length in))) (- c 1))))))
  (defcmd prompt-delete-forward "Delete after the cursor"
    (prompt-edit! (lambda (in c) (if (= c (string-length in)) (values in c)
                                     (values (string-append (substring in 0 c) (substring in (+ c 1) (string-length in))) c)))))
  (defcmd prompt-delete-word "Delete the word before the cursor"
    (prompt-edit! (lambda (in c)
                    (let* ([i (let loop ([i c]) (if (and (> i 0) (char=? (string-ref in (- i 1)) #\space)) (loop (- i 1)) i))]
                           [i (let loop ([i i]) (if (and (> i 0) (not (memv (string-ref in (- i 1)) '(#\space #\/)))) (loop (- i 1)) i))]
                           [i (if (= i c) (max 0 (- c 1)) i)])
                      (values (string-append (substring in 0 i) (substring in c (string-length in))) i)))))
  (defcmd prompt-kill "Clear the input" (prompt-edit! (lambda (in c) (values "" 0))))
  (defcmd prompt-left "Cursor left" (prompt-edit! (lambda (in c) (values in (- c 1)))))
  (defcmd prompt-right "Cursor right" (prompt-edit! (lambda (in c) (values in (+ c 1)))))
  (defcmd prompt-home "Cursor to the start" (prompt-edit! (lambda (in c) (values in 0))))
  (defcmd prompt-end "Cursor to the end" (prompt-edit! (lambda (in c) (values in (string-length in)))))
  (defcmd prompt-next "Next candidate" (prompt-move! 1))
  (defcmd prompt-previous "Previous candidate" (prompt-move! -1))

  ;; ---------------------------------------------------------------------------
  ;; Keymaps

  (define (bind km . specs)
    ;; specs: key command label ...
    (let loop ([s specs])
      (unless (null? s)
        (define-key km (car s) (cadr s) (caddr s))
        (loop (cdddr s)))))

  (define (layer name title on-tap . specs)
    (let ([km (make-keymap name title on-tap)])
      (apply bind km specs)
      km))

  (define (menu name title . specs)
    (let ([km (make-keymap name title)])
      (apply bind km specs)
      km))

  (define movements
    '(("j" left "<<") ("l" right ">>") ("i" up "^") ("k" down "v")
      ("u" previous "<") ("o" next ">") ("y" first "|<") ("p" last ">|")))

  (define (movement-layer name title on-tap prefix label-fmt dirs)
    (let ([km (make-keymap name title on-tap)])
      (for-each (lambda (m)
                  (when (memq (cadr m) dirs)
                    (define-key km (car m) (string->symbol (format "~a-~a" prefix (cadr m)))
                      (format label-fmt (caddr m)))))
                movements)
      km))

  (define delete-layer
    (layer 'delete "Delete" 'delete-one
           "j" 'delete-left "<< Delete" "l" 'delete-right "Delete >>"
           "u" 'delete-previous "< Delete" "o" 'delete-next "Delete >"
           "y" 'delete-to-first "|< Delete" "p" 'delete-to-last "Delete >|"))

  (define cut-layer
    (layer 'cut "Cut" 'cut-one
           "j" 'cut-left "<< Cut" "l" 'cut-right "Cut >>"
           "u" 'cut-previous "< Cut" "o" 'cut-next "Cut >"
           "y" 'cut-to-first "|< Cut" "p" 'cut-to-last "Cut >|"))

  (define open-layer
    (layer 'open "Open" 'change
           "j" 'open-before "<< Open" "l" 'open-after "Open >>"
           "u" 'open-before "< Open" "o" 'open-after "Open >"
           "h" 'insert-before "< Insert" ";" 'insert-after "Insert >"
           "i" 'open-above "Open ^" "k" 'open-below "Open v"))

  (define copy-layer
    (layer 'copy "Copy / Dup" 'copy
           "j" 'duplicate-gap-before "<< Gap Dup" "l" 'duplicate-gap-after "Gap Dup >>"
           "u" 'duplicate-gap-before "< Gap Dup" "o" 'duplicate-gap-after "Gap Dup >"
           "h" 'duplicate-before "< Dup" ";" 'duplicate-after "Dup >"
           "i" 'duplicate-above "Dup ^" "k" 'duplicate-below "Dup v"))

  (define paste-layer
    (layer 'paste "Paste" 'replace
           "j" 'paste-gap-before "<< Gap Paste" "l" 'paste-gap-after "Gap Paste >>"
           "u" 'paste-gap-before "< Gap Paste" "o" 'paste-gap-after "Gap Paste >"
           "h" 'paste-before "< Paste" ";" 'paste-after "Paste >"
           "i" 'paste-above "Paste ^" "k" 'paste-below "Paste v"
           "y" 'replace-history-older "← Replace History" "p" 'replace-history-newer "Replace History →"
           "n" 'replace-cut "Replace Cut" "b" 'paste-system "System Clipboard"))

  (define undo-layer
    (layer 'undo "Undo / Redo" 'undo
           "j" 'undo "Coarse Undo" "l" 'redo "Coarse Redo"
           "u" 'undo-fine "Fine Undo" "o" 'redo-fine "Fine Redo"))

  (define swap-layer
    (movement-layer 'swap "Swap" #f "swap" "Swap ~a" '(left right up down previous next first last)))
  (at-load (keymap-momentary?-set! swap-layer #t))

  (define multicursor-layer
    (let ([km (movement-layer 'multi-cursor "Multi-cursor" #f "add-cursor" "Add Curs ~a"
                              '(left right up down previous next first last))])
      (bind km "h" 'cursor-previous "← Curs" ";" 'cursor-next "Curs →"
            "n" 'cursor-delete "Delete Curs" "f" 'select-all-occurrences "All Occurrences")
      (keymap-momentary?-set! km #t)
      km))

  (define buffer-layer
    (let ([km (layer 'buffers "Buffers" 'switch-buffer
                     "j" 'buffer-previous "<< Buffer" "l" 'buffer-next "Buffer >>"
                     "n" 'buffer-close "Close" "m" 'buffer-alternate "Alternate"
                     "f" 'switch-buffer "Pick")])
      km))

  (define history-layer
    (layer 'history "Selection History" 'selection-back
           "j" 'selection-back "<< Hist" "l" 'selection-forward "Hist >>"
           "u" 'selection-back "< Hist" "o" 'selection-forward "Hist >"))

  (define local-keymap
    (menu 'local "Local"
          "d" 'search "Search" "f" 'search-this "Search This" "r" 'search-repeat "Repeat Search"
          "n" 'select-all-occurrences "All Occurrences"))

  (define transform-keymap
    (menu 'transform "Transform"
          "q" 'case-upper "UPPER CASE" "w" 'case-upper-snake "UPPER_SNAKE_CASE"
          "e" 'case-pascal "PascalCase" "r" 'case-upper-kebab "Upper-Kebab"
          "t" 'case-title "Title Case" "a" 'case-lower "lower case"
          "s" 'case-snake "snake_case" "d" 'case-camel "camelCase" "f" 'case-kebab "kebab-case"
          "k" 'toggle-comment "Line Comment" "|" 'pipe "Pipe"))

  (define surround-keymap
    (let ([km (make-keymap 'surround "Surround")])
      (define-key km "s" (enclosure-keymap "Surround with" surround!) "Surround")
      (define-key km "r" (enclosure-keymap "Delete surround" delete-surround!) "Delete Surround")
      (define-key km "d" (enclosure-keymap "Select inside" (lambda (o c) (select-surround! o c #t))) "Select Inside")
      (define-key km "e" (enclosure-keymap "Select around" (lambda (o c) (select-surround! o c #f))) "Select Around")
      (define-key km "f" (enclosure-keymap "Change surround from"
                                           (lambda (o c)
                                             (enter-layer! (enclosure-keymap "Change surround to"
                                                                             (lambda (o2 c2) (change-surround! o c o2 c2)))
                                                           "f")))
        "Change Surround")
      km))

  (define editor-menu
    (menu 'editor "Editor"
          "enter" 'save-force "Force Save" "c" 'save-all "Save All" "q" 'quit-no-save "Quit No Save"
          "v" 'quit "Quit" "d" 'reload "Reload File" "e" 'reload-all "Reload All Files"
          "k" 'kill-server "Stop Editor" "l" 'list-clients "Clients"
          "f" 'change-directory "Change Work Dir" "n" 'toggle-line-numbers "Line Numbers"
          "w" 'toggle-whitespace "Whitespace"))

  (define pick-menu
    (menu 'pick "Pick"
          "d" 'open-file "File" "f" 'switch-buffer "Buffer" "o" 'open-path "Path"
          "c" 'command-palette "Command" "t" 'pick-theme "Theme" "m" 'messages "Messages"
          "s" 'scratch "Scratch"))

  (define context-menu
    (menu 'context "Context"
          "e" 'eval-selection "Eval Selection" "b" 'eval-buffer "Eval Buffer"
          "|" 'pipe "Pipe"))

  (define space-keymap
    (menu 'space "Space"
          "j" editor-menu "Editor" "k" pick-menu "Pick" "l" context-menu "Context"
          ";" 'explore "Explorer" "/" 'help "Help" "space" 'command-palette "Command"
          "e" 'eval-expression "Eval" "v" 'paste-system "Paste System"))

  (at-load (bind normal-keymap
        "j" 'move-left "<<" "l" 'move-right ">>" "i" 'move-up "^" "k" 'move-down "v"
        "u" 'move-previous "<" "o" 'move-next ">" "y" 'move-first "|<" "p" 'move-last ">|"
        "m" 'jump "Jump" "M" 'goto-index "Index" "." 'parent-line "Parent Line"
        "a" 'select-line "LINE" "A" 'select-line-full "LINE*" "d" 'select-node "NODE"
        "D" 'select-node "NODE*" "s" 'select-word "WORD" "S" 'select-big-word "WORD*"
        "w" 'select-subword "SUBWORD" "W" 'select-char "CHAR" "E" 'select-paragraph "PARAGRAPH"
        "n" local-keymap "Local" "f" 'extend "Extend"
        "h" 'insert-before "← Insert" ";" 'insert-after "Insert →"
        "g" open-layer "Change/Open" "G" 'change-cut "Change X"
        "r" delete-layer "Delete" "x" cut-layer "Cut" "c" copy-layer "Copy/Dup"
        "v" paste-layer "Replace/Paste" "t" swap-layer "Swap" "b" multicursor-layer "Multi-cursor"
        "z" undo-layer "Undo/Redo" "Z" 'redo "Redo"
        "I" 'join "Join" "K" 'break "Break" "L" 'indent "Indent" "J" 'dedent "Dedent"
        "F" transform-keymap "Transform" "," surround-keymap "Surround"
        "enter" 'save "Save" "shift+enter" 'save-as "Save As"
        "e" buffer-layer "Buffer" "q" history-layer "Selection History"
        "?" 'swap-anchor "⇋ Anchor" "/" 'swap-cursor "⇋ Cursor"
        "backspace" 'selection-back "← Select" "tab" 'selection-forward "Select →"
        "space" space-keymap "Space" "esc" 'escape "Escape"
        "alt+k" 'scroll-down "Scroll ↓" "alt+i" 'scroll-up "Scroll ↑"
        "pagedown" 'scroll-down "Scroll ↓" "pageup" 'scroll-up "Scroll ↑"
        "alt+;" 'center "Align View" "ctrl+z" 'suspend "Suspend" "ctrl+q" 'quit "Quit"
        "left" 'move-left "<<" "right" 'move-right ">>" "up" 'move-up "^" "down" 'move-down "v"))

  (at-load (bind insert-keymap
        "esc" 'exit-insert "Normal Mode" "enter" 'newline "Newline"
        "backspace" 'delete-backward "Delete ←" "delete" 'delete-forward "Delete →"
        "alt+backspace" 'delete-word-backward "Delete Word ←" "ctrl+backspace" 'delete-word-backward "Delete Word ←"
        "ctrl+w" 'delete-word-backward "Delete Word ←" "ctrl+delete" 'delete-word-forward "Delete Word →"
        "alt+d" 'delete-word-forward "Delete Word →"
        "tab" 'insert-tab "Indent" "shift+tab" 'dedent "Dedent"
        "left" 'cursor-left "Char ←" "right" 'cursor-right "Char →" "up" 'cursor-up "Line ↑" "down" 'cursor-down "Line ↓"
        "ctrl+left" 'cursor-word-left "Word ←" "ctrl+right" 'cursor-word-right "Word →"
        "alt+left" 'cursor-word-left "Word ←" "alt+right" 'cursor-word-right "Word →"
        "home" 'cursor-line-start "Line Start" "end" 'cursor-line-end "Line End"
        "alt+y" 'cursor-line-start "Line ←" "alt+p" 'cursor-line-end "Line →"
        "ctrl+a" 'cursor-line-start "Line Start" "ctrl+e" 'cursor-line-end "Line End"
        "ctrl+k" 'kill-line "Kill Line" "ctrl+u" 'kill-line-backward "Kill Line ←"
        "ctrl+z" 'suspend "Suspend"))

  (at-load (bind prompt-keymap
        "enter" 'prompt-accept "Accept" "esc" 'prompt-cancel "Cancel" "ctrl+c" 'prompt-cancel "Cancel"
        "backspace" 'prompt-delete-backward "Delete ←" "delete" 'prompt-delete-forward "Delete →"
        "alt+backspace" 'prompt-delete-word "Delete Word" "ctrl+w" 'prompt-delete-word "Delete Word"
        "ctrl+backspace" 'prompt-delete-word "Delete Word" "ctrl+u" 'prompt-kill "Clear"
        "left" 'prompt-left "←" "right" 'prompt-right "→" "home" 'prompt-home "Start" "end" 'prompt-end "End"
        "ctrl+a" 'prompt-home "Start" "ctrl+e" 'prompt-end "End"
        "down" 'prompt-next "Next" "up" 'prompt-previous "Previous"
        "ctrl+n" 'prompt-next "Next" "ctrl+p" 'prompt-previous "Previous"
        "tab" 'prompt-next "Next" "shift+tab" 'prompt-previous "Previous"))

  ;; ---------------------------------------------------------------------------
  ;; Init files

  (define (init-file-path)
    (let ([xdg (getenv "XDG_CONFIG_HOME")] [home (getenv "HOME")])
      (cond
       [(getenv "QUAD_INIT") (getenv "QUAD_INIT")]
       [xdg (path-join xdg "quad/init.ss")]
       [home (path-join home ".config/quad/init.ss")]
       [else #f])))

  ;; Load a Scheme file into the quad environment: everything quad exports is
  ;; in scope, and its definitions become part of the editor.
  (define (load-init-file! path)
    (when (and path (file-exists? path))
      (guard (e [#t (message-error "Error in ~a: ~a" path
                                   (if (condition? e)
                                       (call-with-string-output-port (lambda (p) (display-condition e p)))
                                       e))])
        (load path (lambda (x) (eval x (quad-environment))))))))
