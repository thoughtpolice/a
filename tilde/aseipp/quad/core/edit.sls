;; edit.sls -- editing: selections and movement, inserting, deleting,
;; copying and pasting, transforms and surrounds, cursors, searching
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The operations the standard commands are made of (commands.sls defines
;; and binds those), for any key scheme's keys to use.
(library (quad edit)
  (export
          cur cv sel-range current-unit move-range range->sel extend-sel line-unit move! select-mode!
          selection-text
          sels-texts edit-sels! place! gap-between line-indent indent-for-newline enter-insert!
          exit-insert! insert-at-cursors! insert-newline! delete-backward! delete-forward!
          word-start-before word-end-after delete-word-backward! delete-word-forward!
          move-cursors! cursor-vertical delete-towards! delete-to! change! copy! replace-with!
          paste! duplicate! replace-history! replace-cut! open! swap! join-lines! break-line!
          indent-lines! case-transform transform-sels! toggle-comment! enclosures
          enclosure-keymap find-enclosure surround! delete-surround! select-surround!
          change-surround! add-cursor! cycle-primary! delete-cursor! select-all-occurrences!
          jump! search! search-prompt! goto-line! parent-line! edit-install! reload-buffer!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (only (quad native) search-new search-all))


  (define (cur) (current-buffer))
  (define (cv) (current-view))


  ;; ---------------------------------------------------------------------------
  ;; Selections and movement

  (define (sel-range s) (cons (sel-start s) (sel-end s)))
  (define (hull s) (cons (sel-range-start s) (sel-range-end s)))

  (define (current-unit b r)
    ((selection-mode-current (selection-mode-of b)) b r))

  (define (move-range b r dir)
    ((selection-mode-move (selection-mode-of b)) b r dir))

  (define (range->sel r) (make-sel (car r) (cdr r)))

  ;; s, extended to r from where it was anchored.
  (define (extend-sel s r) (make-sel (car r) (cdr r) (or (sel-anchor s) (sel-range s))))

  ;; Selection s, gone to the unit r: extended to it while extending, else
  ;; on it; s itself where there is none.
  (define (to-unit s r)
    (cond [(not r) s] [(view-extending? (cv)) (extend-sel s r)] [else (range->sel r)]))

  ;; The unit at line's indentation.
  (define (line-unit b line)
    (let ([p (line-indent-end (buffer-text b) line)]) (current-unit b (cons p p))))

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
      (let ([moved (parameterize ([goal-column (view-sticky-col (cv))])
                     (map (lambda (s) (to-unit s (move-range b (sel-range s) dir))) (sels-of b)))])
        (when (eq? (car moved) (primary)) (message "No ~a ~a" (selection-mode-label (selection-mode-of b)) dir))
        (set-sels! b moved))))

  (define (select-mode! name)
    (let ([b (cur)])
      (push-selection-history! b)
      (set-selection-mode! b name)
      (view-sticky-col-set! (cv) #f)
      (set-sels! b (map (lambda (s) (to-unit s (current-unit b (hull s)))) (sels-of b)))))

  (define (selection-text b s) (buffer-substring b (sel-range-start s) (sel-range-end s)))
  (define (sels-texts b) (map (lambda (s) (selection-text b s)) (sels-of b)))

  ;; Edit each selection: (f sel) returns #f to leave it alone, or a list
  ;; (start end text new-sel) where (new-sel start') builds the selection
  ;; from where the replacement text begins after the edit. f sees the
  ;; selections in order (map's order is not), so that it can give each
  ;; the next of a list of texts.
  (define (edit-sels! f)
    (let* ([b (cur)]
           [plans (let loop ([ss (sels-of b)] [acc '()])
                    (if (null? ss)
                        (reverse acc)
                        (loop (cdr ss) (cons (or (f (car ss)) (list #f (car ss))) acc))))]
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
           [default (if (selection-mode-line-wise? (selection-mode-of b)) "\n" " ")])
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




  (define (insert-newline!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (sel)
         (let* ([p (sel-start sel)] [t (buffer-text b)]
                ;; Drop trailing whitespace before the break.
                [ws-start (blanks-before t p (text-line-start t (text-line-of t p)))]
                [indent (indent-for-newline b p)]
                [between (and (< p (text-length t)) (> p 0)
                              (let ([pair (assv (text-ref t (- p 1)) '((#\{ . #\}) (#\( . #\)) (#\[ . #\])))])
                                (and pair (char=? (text-ref t p) (cdr pair)))))]
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
                       [pair? (and next (get-var 'auto-pairs b)
                                   (let ([pair (assv prev closers)]) (and pair (char=? next (cdr pair)))))]
                       ;; In leading indentation, delete back to the previous stop.
                       [line-start (text-line-start t (text-line-of t p))]
                       [unit (string-length (get-var 'indent-unit b))]
                       [in-indent? (and (> unit 1) (char=? prev #\space)
                                        (let loop ([i line-start]) (or (= i p) (and (char=? (text-ref t i) #\space) (loop (+ i 1))))))]
                       [n (if in-indent?
                              (let ([col (- p line-start)]) (max 1 (let ([r (remainder col unit)]) (if (= r 0) unit r))))
                              (- p (grapheme-before b p)))])
                  (list (- p n) (if pair? (+ p 1) p) "" (lambda (np) (make-sel np np))))))))))

  (define (delete-forward!)
    (let ([b (cur)])
      (edit-sels!
       (lambda (sel)
         (let ([p (sel-start sel)])
           (and (< p (buffer-length b))
                (list p (grapheme-after b p) "" (lambda (np) (make-sel np np)))))))))

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
          (let ([q (text-pos-at t target (- p (text-line-start t line)))])
            ;; Not inside a cluster.
            (if (< q (text-length t))
                (grapheme-start (lambda (i) (text-ref t i)) q)
                q))
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
             ;; The neighbor found, and whether it is after the selection.
             (let ([n (or n1 n2)] [after? (if n1 fwd? (not fwd?))])
               (cond
                [(not n) (list (car r) (cdr r) "" (lambda (np) (make-sel np np)))]
                [after? (list (car r) (car n) "" (lambda (np) (make-sel np (+ np (- (cdr n) (car n))))))]
                [else (list (cdr n) (cdr r) "" (lambda (np) (make-sel (- np (- (cdr n) (car n))) np)))])))))
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
    (let ([e (clipboard-top)]) (and e (fit-entry e (length (sels-of b))))))

  ;; Clipboard entry e for n selections: a text each, if it has n, else
  ;; the whole entry for all of them.
  (define (fit-entry e n)
    (if (= (length e) n) e (make-list n (string-join e "\n"))))

  (define (copy!)
    (let ([b (cur)])
      (clipboard-push! (sels-texts b))
      (message "Copied ~a selection~a" (length (sels-of b)) (if (> (length (sels-of b)) 1) "s" ""))))

  (define (replace-with! texts)
    (edit-sels!
     (lambda (s)
       (let ([txt (car texts)])
         (set! texts (cdr texts))
         (list (sel-range-start s) (sel-range-end s) txt
               (lambda (np) (make-sel np (+ np (string-length txt)))))))))

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
            (replace-with! (fit-entry e (length (sels-of b))))
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
                       [trim-start (blanks-before t e (text-line-start t line))]
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
                [ws (blanks-before t p (text-line-start t (text-line-of t p)))]
                [indent (indent-for-newline b ws)]
                [len (sel-length s)])
           (list ws p (string-append "\n" indent)
                 (lambda (np) (let ([q (+ np 1 (string-length indent))]) (make-sel q (+ q len))))))))))

  ;; The lines b's selections touch, in order, each once.
  (define (sels-lines b)
    (let ([t (buffer-text b)] [seen (make-eqv-hashtable)])
      (for-each (lambda (s)
                  (let ([last (text-line-of t (max (sel-range-start s) (- (sel-range-end s) 1)))])
                    (do ([l (text-line-of t (sel-range-start s)) (+ l 1)]) ((> l last))
                      (hashtable-set! seen l #t))))
                (sels-of b))
      (sort < (vector->list (hashtable-keys seen)))))

  ;; Indent or dedent every line the selections touch.
  (define (indent-lines! dedent?)
    (let* ([b (cur)] [t (buffer-text b)] [unit (get-var 'indent-unit b)]
           [lines (sels-lines b)]
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
        (let ([before (map (lambda (s) (cons (sel-range-start s) (sel-range-end s))) (sels-of b))])
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
          [(toggle) (list->string (map (lambda (c) (if (char-upper-case? c) (char-downcase c) (char-upcase c)))
                                       (string->list s)))]
          [(upper-snake) (string-join (map string-upcase ws) "_")]
          [(snake) (string-join (map string-downcase ws) "_")]
          [(kebab) (string-join (map string-downcase ws) "-")]
          [(upper-kebab) (string-join (map capitalize ws) "-")]
          [(pascal) (apply string-append (map capitalize ws))]
          [(camel) (if (null? ws) "" (apply string-append (string-downcase (car ws)) (map capitalize (cdr ws))))]
          [(title) (string-join (map capitalize ws) " ")]))))

  (define (transform-sels! f) (replace-with! (map f (sels-texts (cur)))))

  ;; Toggle line comments on the lines the selections touch.
  (define (toggle-comment!)
    (let* ([b (cur)] [t (buffer-text b)]
           [prefix (syntax-line-comment (major-mode-syntax (buffer-major-mode b)))])
      (if (not prefix)
          (message "~a has no line comments" (major-mode-name (buffer-major-mode b)))
          (let* ([trimmed (string-trim-right prefix)]
                 [lines (filter (lambda (l) (not (blank-line? t l))) (sels-lines b))]
                 [starts (map (lambda (l) (line-indent-end t l)) lines)]
                 [commented? (for-all (lambda (s) (text-match-at? t s trimmed)) starts)]
                 [col (apply min 1000 (map (lambda (l s) (- s (text-line-start t l))) lines starts))])
            (buffer-edit! b (map (lambda (l s)
                                   (cond
                                    [(not commented?) (let ([s (+ (text-line-start t l) col)]) (list s s prefix))]
                                    [(text-match-at? t s prefix) (list s (+ s (string-length prefix)) "")]
                                    [else (list s (+ s (string-length trimmed)) "")]))
                                 lines starts))
            ;; Select the lines toggled, so toggling again undoes it.
            (unless (null? lines)
              (set-sels! b (list (make-sel (text-line-start t (car lines))
                                           (text-line-end t (car (last-pair lines)))))))))))

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

  (define (delete-surround! open close) (change-surround! open close "" ""))

  (define (select-surround! open close inside?)
    (let* ([b (cur)] [s (primary)] [enc (find-enclosure b (sel-range-start s) (sel-range-end s) open close)])
      (if enc
          (set-sels! b (list (if inside? (make-sel (+ 1 (car enc)) (cdr enc)) (make-sel (car enc) (+ 1 (cdr enc))))))
          (message "No surrounding ~a~a" open close))))

  (define (change-surround! from-open from-close to-open to-close)
    (let* ([b (cur)] [s (primary)] [enc (find-enclosure b (sel-range-start s) (sel-range-end s) from-open from-close)])
      (if enc
          (let ([starts (buffer-edit! b (list (list (car enc) (+ 1 (car enc)) to-open) (list (cdr enc) (+ 1 (cdr enc)) to-close)))])
            (set-sels! b (list (make-sel (car starts) (+ (cadr starts) (string-length to-close))))))
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
          ;; The text itself (not a pattern), its case kept.
          (let ([all (map (lambda (m) (make-sel (car m) (cdr m)))
                          (search-all (search-new needle #f #f) (text-rope t) 0 (text-length t)))])
            (set-sels! b (cons (or (find (lambda (s) (= (sel-start s) (sel-start p))) all) p) all))
            (message "~a occurrences" (length all))))))

  ;; ---------------------------------------------------------------------------
  ;; Jumping, searching and the index

  (define jump-alphabet "fjdkslaghrueiwoqptyvbcnmxz")

  (define (show-jumps! k)
    (let* ([b (cur)] [g (view-geometry)]
           [first (view-top (cv))]
           [last (min (- (text-line-count (buffer-text b)) 1) (+ first (if g (list-ref g 2) 20) -1))]
           [units ((selection-mode-visible (selection-mode-of b)) b first last)]
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
         (set-sels! b (list (to-unit (primary) r)))))))

  ;; Search for pattern, selecting the match nearest the cursor: literal
  ;; text, or with regex? a regular expression.
  (define search!
    (case-lambda
     [(pattern) (search! pattern #f)]
     [(pattern regex?)
      (let ([b (cur)])
        (search-pattern-set! b pattern regex?)
        (buffer-local-set! b 'last-search (cons pattern regex?))
        (push-selection-history! b)
        (set-selection-mode! b 'search)
        (let ([r (current-unit b (sel-range (primary)))])
          (cond
           [r (set-sels! b (list (range->sel r)))]
           [(search-error b) => (lambda (why) (message-error "Not a pattern: ~a" why))]
           [else (message-error "No match for ~s" pattern)])))]))

  (define (search-prompt! regex?)
    (let* ([b (cur)] [origin (sels-of b)] [mode (view-selection-mode (cv))])
      (open-prompt!
       (make-prompt (if regex? "regex:" "search:") "" #f
                    (lambda (s) (if (string=? s "")
                                    (begin (set-sels! b origin) (set-selection-mode! b mode))
                                    (search! s regex?)))
                    ;; Incremental: show the first match as you type, or
                    ;; what is wrong with the pattern so far.
                    (lambda (s)
                      (when (> (string-length s) 0)
                        (search-pattern-set! b s regex?)
                        (let ([r ((selection-mode-current (find-selection-mode 'search)) b (sel-range (car origin)))])
                          (cond
                           [r (clear-message!) (set-sels! b (list (range->sel r)))]
                           [(search-error b) => (lambda (why) (message "Not a pattern yet: ~a" why))]))))
                    'line))))

  (define (goto-line! n)
    (let* ([b (cur)] [t (buffer-text b)] [line (clamp (- n 1) 0 (- (text-line-count t) 1))])
      (push-selection-history! b)
      (let ([r (line-unit b line)])
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
          (let ([r (line-unit b l)])
            (when r (set-sels! b (list (range->sel r)))))]
         [else (loop (- l 1))]))))


  ;; What this registers, once: (quad commands) calls it as it loads, as
  ;; nothing would run this library's own at-loads (a library runs only
  ;; once something uses it).
  (define (edit-install!)
    (set-var! 'insert-text-function insert-at-cursors!))

  ;; ---------------------------------------------------------------------------
  ;; Files

  ;; A binary buffer (an image's) shows its file as it is now: only its
  ;; time is noted.
  (define (reload-buffer! b)
    (when (and (buffer-path b) (file-exists? (buffer-path b)))
      (unless (binary-buffer? b)
        (let ([sels (sels-of b)])
          (buffer-replace-all! b (read-file-string (buffer-path b)))
          (buffer-mark-saved! b)
          (set-sels! b sels)))
      (buffer-local-set! b 'mtime (file-modification-time (buffer-path b))))))
