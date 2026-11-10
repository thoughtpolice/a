;; helix.sls -- Helix's keys
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The key scheme 'helix (keymap.sls): (set-var! 'key-scheme 'helix).
;; Helix edits selection first, as Kakoune does, and so does quad: every
;; motion acts on every selection. h j k l (and the arrows) move a cursor
;; a character wide; w b e (W B E) select from the cursor to where they
;; go, and pressing again steps on; x selects lines, more each time; %
;; selects everything; v switches to select mode, where motions extend
;; what is selected; ; drops a selection to its cursor, alt+; flips it, ,
;; keeps the primary; C (alt+C) adds a cursor below (above); s selects
;; what a regular expression matches in the selections, alt+s splits them
;; into lines. d c y p P R delete, change, yank, paste and replace what is
;; selected ("x first: in register x); Q records a macro until Q again,
;; q plays it (in @, or the register "x names); i a I A o O insert; u U
;; undo and redo; > < J ~ ` alt+` indent,
;; dedent, join and change case. g goes places (gg ge gh gl gs, gn gp
;; buffers, gd gr gy gi with a language server); m matches (mm the
;; bracket, mi( ma( inside and around, ms( surround, md( mr([ change
;; surrounds). / ? n N * search; : runs ex commands (vi.sls); ctrl+c
;; comments; ctrl+d ctrl+u scroll. The space menu, panes (ctrl+w) and
;; insert mode are quad's, as in every scheme: space f and space b are
;; Helix's file and buffer pickers there too.
(library (quad ext helix)
  (export helix-keymap)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad ext vi))

  (define helix-keymap (make-keymap 'helix "Helix"))

  ;; ---------------------------------------------------------------------------
  ;; Selections, each with a head: the end its cursor is at.

  (define (b*) (vi-buffer))

  ;; A selection's head: the primary's, as last set; another's, its end.
  (define (head-of s)
    (let ([h (view-local (current-view) 'hx-head #f)])
      (if (and h (eq? s (primary)) (<= (sel-range-start s) h) (< h (max (sel-range-end s) (+ 1 (sel-range-start s)))))
          h
          (max (sel-range-start s) (- (sel-range-end s) 1)))))

  ;; The selection from anchor to head, both inclusive.
  (define (selection-of a h) (make-sel (min a h) (min (vi-len) (+ 1 (max a h)))))

  ;; Map every selection to (values anchor head), from (f sel head); the
  ;; primary's head is kept. In select mode, the anchor stays where it is.
  (define (each! f)
    (if (selecting?)
        (let-values ([(a h) (f (primary) (head))]) (select-set-head! h))
        (let* ([ss (sels-of (b*))]
               [new (map (lambda (s) (call-with-values (lambda () (f s (head-of s))) cons)) ss)])
          (set-sels! (b*) (map (lambda (ah) (selection-of (car ah) (cdr ah))) new))
          (view-local-set! (current-view) 'hx-head (cdr (car new))))))

  ;; A cursor a character wide where (f head) is.
  (define (move-to! f)
    (each! (lambda (s h) (let ([p (clamp (f h) 0 (max 0 (- (vi-len) 1)))]) (values p p)))))

  (define (line-step h n)
    (let* ([t (buffer-text (b*))] [col (- h (bol h))]
           [line (clamp (+ (line-of h) n) 0 (- (text-line-count t) 1))])
      (min (+ (line-start line) col) (max (line-start line) (- (line-end line) 1)))))

  ;; Words: w and e select from the cursor to the next word's start, or
  ;; its end; b back to the start of a word. Pressed again, the next.
  (define (select-word-forward! mode end?)
    (count-times!
     (lambda ()
       (each! (lambda (s h)
                ;; A selection the last w made ends at the head: the next
                ;; starts after it, past the end of its line if it is
                ;; there. From a cursor, it starts there. A word's
                ;; selection stops at its line's end.
                (let* ([from (if (and (< (+ h 1) (vi-len)) (> (sel-length s) 1) (= h (- (sel-range-end s) 1))) (+ h 1) h)]
                       [from (let skip ([f from])
                               (if (and (< (+ f 1) (vi-len)) (= f (eol f))) (skip (+ f 1)) f))]
                       [to (if end?
                               (word-end mode from)
                               (min (- (word-forward mode from) 1) (max from (- (eol from) 1))))])
                  (values from (max from to))))))))

  (define (select-word-backward! mode)
    (count-times!
     (lambda ()
       (each! (lambda (s h)
                (let* ([from (if (and (> h 0) (> (sel-length s) 1) (= h (sel-range-start s))) (- h 1) h)])
                  (values from (word-backward mode from))))))))

  ;; x: the lines the selections cover; if they are just that, one more.
  (define (select-lines!)
    (count-times!
     (lambda ()
       (each! (lambda (s h)
                (let* ([s0 (sel-range-start s)] [e0 (sel-range-end s)]
                       [whole? (and (= s0 (bol s0)) (> e0 s0) (= (- e0 1) (eol (- e0 1))))]
                       [last (if whole? (min (- (vi-len) 1) e0) (max s0 (- e0 1)))])
                  (values (bol s0) (min (- (vi-len) 1) (eol last)))))))))

  ;; ---------------------------------------------------------------------------
  ;; Acting on the selections

  (define (texts) (sels-texts (b*)))

  (define (delete! yank?)
    (when yank? (register-store! (texts) #f 'delete))
    (edit-sels! (lambda (s) (list (sel-range-start s) (sel-range-end s) "" (lambda (p) (make-sel p (min (vi-len) (+ p 1))))))))

  (define (change!)
    (register-store! (texts) #f 'delete)
    (edit-sels! (lambda (s) (list (sel-range-start s) (sel-range-end s) "" (lambda (p) (make-sel p p)))))
    (enter-insert! 'start))

  (define (yank-selections!)
    (let ([n (length (sels-of (b*)))])
      (register-store! (texts) #f 'yank)
      (message "Yanked ~a selection~a" n (if (= n 1) "" "s"))))

  ;; Paste a register's texts, one to each selection (the last again for
  ;; any more), after them or before, or in their place; as many times as
  ;; the count.
  (define (paste! where)
    (let ([top (let ([r (register-fetch)]) (and r (car r)))] [n (take-count!)])
      (do ([i 0 (+ i 1)]) ((or (not top) (= i (if (eq? where 'replace) 1 n))))
        (paste-texts! top where))))

  (define (paste-texts! top where)
    ;; A text for each selection, the last again for any more.
    (let ([texts (let loop ([k (length (sels-of (b*)))] [l top] [acc '()])
                   (if (= k 0)
                       (reverse acc)
                       (loop (- k 1) (if (null? (cdr l)) l (cdr l)) (cons (car l) acc))))])
      (if (eq? where 'replace) (replace-with! texts) (place! texts where))))

  ;; s: what pattern (a regular expression) matches within each selection.
  (define (select-matches!)
    (read-string-prompt "select:"
                        (lambda (pat)
                          (unless (string=? pat "")
                            (let ([b (b*)] [ss (sels-of (b*))])
                              (search-pattern-set! b pat #t)
                              (let ([found (apply append (map (lambda (s) (search-matches b (sel-range-start s) (sel-range-end s)))
                                                              ss))])
                                (cond
                                 [(pair? found) (set-sels! b (map (lambda (m) (make-sel (car m) (cdr m))) found))]
                                 [(search-error b) => (lambda (why) (message-error "Not a pattern: ~a" why))]
                                 [else (message-error "No match for ~s" pat)])))))))

  ;; alt+s: each selection's lines, a selection each.
  (define (split-lines!)
    (let ([b (b*)])
      (set-sels! b
                 (apply append
                        (map (lambda (s)
                               (let loop ([line (line-of (sel-range-start s))] [acc '()])
                                 (let ([ls (max (sel-range-start s) (line-start line))]
                                       [le (min (sel-range-end s) (line-end line))])
                                   (if (or (> ls (sel-range-end s)) (>= line (text-line-count (buffer-text b))))
                                       (reverse acc)
                                       (loop (+ line 1) (if (< ls le) (cons (make-sel ls le) acc) acc))))))
                             (sels-of b))))))

  (define (select-search! m) (set-sels! (b*) (list (make-sel (car m) (cdr m))))
    (view-local-set! (current-view) 'hx-head (max (car m) (- (cdr m) 1))))

  ;; n (again?) or N: the next match the way the search went, or the other
  ;; way, from the selection's end or start.
  (define (search-next! again?)
    (let* ([s (primary)]
           [forward? (eq? again? (> (buffer-local (b*) 'vi-search-dir 1) 0))]
           [m (search-step (if forward? (head-of s) (sel-range-start s)) again?)])
      (if m (select-search! m) (message "No more matches"))))

  ;; ---------------------------------------------------------------------------
  ;; Goto (g) and match (m)

  (define (run-if name)
    (lambda () (if (find-command name) (run-command name) (message "~a needs a language server" name))))

  (define goto-keymap
    (let ([km (make-keymap 'helix-goto "Goto")])
      (bind km
            "g" (lambda () (let ([n (take-count! #f)])
                             (move-to! (lambda (h) (first-nonblank (line-start (if n (- n 1) 0)))))))
            "File Start"
            "e" (lambda () (move-to! (lambda (h) (line-start (- (text-line-count (buffer-text (b*))) 1))))) "File End"
            "h" (lambda () (move-to! bol)) "Line Start"
            "l" (lambda () (move-to! last-char)) "Line End"
            "s" (lambda () (move-to! first-nonblank)) "First Non-blank"
            "n" 'buffer-next "Next Buffer" "p" 'buffer-previous "Previous Buffer"
            "d" (run-if 'lsp-definition) "Definition" "D" (run-if 'lsp-declaration) "Declaration"
            "y" (run-if 'lsp-type-definition) "Type" "i" (run-if 'lsp-implementation) "Implementation"
            "r" (run-if 'lsp-references) "References")
      km))

  ;; An enclosure layer: (proc open close) for the character typed.
  (define (enclosure-keymap* title proc)
    (char-keymap 'helix-enclosure title
                 (lambda (c)
                   (let ([enc (enclosure-of c)])
                     (if enc (proc (car enc) (cadr enc)) (message "~a is not a pair" c))))))

  (define (select-enclosure! open close inside?)
    (let* ([b (b*)] [s (primary)] [found (enclosure-at (sel-range-start s) (sel-range-end s) open close)])
      (if found
          (set-sels! b (list (if inside? (make-sel (+ 1 (car found)) (cdr found)) (make-sel (car found) (+ 1 (cdr found))))))
          (message "Not inside ~a~a" open close))))

  (define match-keymap
    (let ([km (make-keymap 'helix-match "Match")])
      (bind km
            "m" (lambda ()
                  (let* ([h (head-of (primary))] [m (matching-bracket h)])
                    (if m (move-to! (lambda (_) m)) (message "No bracket here"))))
            "Matching Bracket"
            "i" (enclosure-keymap* "Select inside" (lambda (o c) (select-enclosure! o c #t))) "Inside"
            "a" (enclosure-keymap* "Select around" (lambda (o c) (select-enclosure! o c #f))) "Around"
            "s" (enclosure-keymap* "Surround with" surround!) "Surround"
            "d" (enclosure-keymap* "Delete surround" delete-surround!) "Delete Surround"
            "r" (enclosure-keymap* "Change surround from"
                                   (lambda (o c)
                                     (enter-layer! (enclosure-keymap* "Change surround to"
                                                                      (lambda (o2 c2) (change-surround! o c o2 c2)))
                                                   "r")))
            "Replace Surround")
      km))

  ;; ---------------------------------------------------------------------------
  ;; The keys

  (define (counted f) (lambda () (count-times! f)))

  (define (insert-at! where)
    (select-stop!)
    (case where
      [(before) (enter-insert! 'start)]
      [(after) (enter-insert! 'end)]
      [else
       (let* ([h (head-of (primary))] [p (if (eq? where 'line-start) (first-nonblank h) (eol h))])
         (set-sels! (b*) (list (make-sel p p)))
         (enter-insert! 'start))]))

  (define (toggle-select!)
    (if (selecting?)
        (begin (view-local-set! (current-view) 'vi-select #f) (message ""))
        (let* ([s (primary)] [h (head-of s)] [a (if (= h (sel-range-start s)) (max h (- (sel-range-end s) 1)) (sel-range-start s))])
          (view-local-set! (current-view) 'vi-select 'char)
          (view-local-set! (current-view) 'vi-anchor a)
          (select-set-head! h))))

  (at-load
   (bind-count-digits! helix-keymap)
   (bind helix-keymap
         "h" (counted (lambda () (move-to! (lambda (h) (max (bol h) (- h 1)))))) "←"
         "l" (counted (lambda () (move-to! (lambda (h) (min (last-char h) (+ h 1)))))) "→"
         "j" (counted (lambda () (move-to! (lambda (h) (line-step h 1))))) "↓"
         "k" (counted (lambda () (move-to! (lambda (h) (line-step h -1))))) "↑"
         "left" (counted (lambda () (move-to! (lambda (h) (max (bol h) (- h 1)))))) "←"
         "right" (counted (lambda () (move-to! (lambda (h) (min (last-char h) (+ h 1)))))) "→"
         "down" (counted (lambda () (move-to! (lambda (h) (line-step h 1))))) "↓"
         "up" (counted (lambda () (move-to! (lambda (h) (line-step h -1))))) "↑"
         "w" (lambda () (select-word-forward! 'word #f)) "Next Word"
         "W" (lambda () (select-word-forward! 'big-word #f)) "Next WORD"
         "e" (lambda () (select-word-forward! 'word #t)) "Word End"
         "E" (lambda () (select-word-forward! 'big-word #t)) "WORD End"
         "b" (lambda () (select-word-backward! 'word)) "Previous Word"
         "B" (lambda () (select-word-backward! 'big-word)) "Previous WORD"
         "x" select-lines! "Select Line"
         "%" (lambda () (set-sels! (b*) (list (make-sel 0 (vi-len))))) "Select All"
         "v" toggle-select! "Select Mode"
         ";" (lambda () (each! (lambda (s h) (values h h)))) "Collapse"
         "alt+;" (lambda ()
                   (each! (lambda (s h)
                            (let ([other (if (= h (sel-range-start s)) (max h (- (sel-range-end s) 1)) (sel-range-start s))])
                              (values h other)))))
         "Flip"
         "," (lambda () (set-sels! (b*) (list (primary)))) "Keep Primary"
         "C" (counted (lambda () (run-command 'add-cursor-down))) "Cursor Below"
         "alt+C" (counted (lambda () (run-command 'add-cursor-up))) "Cursor Above"
         "s" select-matches! "Select Matches"
         "alt+s" split-lines! "Split Lines"
         "d" (lambda () (delete! #t)) "Delete" "alt+d" (lambda () (delete! #f)) "Delete, No Yank"
         "c" change! "Change"
         "y" yank-selections! "Yank"
         "p" (lambda () (paste! 'after)) "Paste After"
         "P" (lambda () (paste! 'before)) "Paste Before"
         "\"" (char-keymap 'helix-register "Register" register-key!) "Register"
         ;; Into the register "x names, else @.
         "Q" (lambda () (if (recording) (record-stop!) (record-start! (or (take-register!) #\@)))) "Record Macro"
         "q" (lambda () (run-macro! (or (take-register!) #\@))) "Play Macro"
         "R" (lambda () (paste! 'replace)) "Replace"
         "i" (lambda () (insert-at! 'before)) "Insert" "a" (lambda () (insert-at! 'after)) "Append"
         "I" (lambda () (insert-at! 'line-start)) "Insert At Start" "A" (lambda () (insert-at! 'line-end)) "Append At End"
         "o" (lambda () (select-stop!) (run-command 'open-below)) "Open Below"
         "O" (lambda () (select-stop!) (run-command 'open-above)) "Open Above"
         "u" (counted (lambda () (run-command 'undo))) "Undo" "U" (counted (lambda () (run-command 'redo))) "Redo"
         ">" 'indent "Indent" "<" 'dedent "Dedent" "J" 'join "Join"
         "~" (lambda () (transform-sels! (case-transform 'toggle))) "Switch Case"
         "`" (lambda () (transform-sels! (case-transform 'lower))) "Lower"
         "alt+`" (lambda () (transform-sels! (case-transform 'upper))) "Upper"
         "g" goto-keymap "Goto" "m" match-keymap "Match"
         ;; ]g and [g: the next and previous change (the jj extension's).
         "]" (let ([km (make-keymap 'helix-next "Next")])
               (define-key km "g" (lambda () (run-command-if 'jj-next-change)) "Change")
               km)
         "Next"
         "[" (let ([km (make-keymap 'helix-previous "Previous")])
               (define-key km "g" (lambda () (run-command-if 'jj-previous-change)) "Change")
               km)
         "Previous"
         "/" (lambda () (vi-search-prompt! 1 select-search!)) "Search"
         "?" (lambda () (vi-search-prompt! -1 select-search!)) "Search Back"
         "n" (lambda () (search-next! #t)) "Next Match" "N" (lambda () (search-next! #f)) "Previous Match"
         "*" 'search-this "Search Selection"
         ":" ex-prompt! "Command"
         "ctrl+c" 'toggle-comment "Comment"
         "ctrl+d" 'scroll-down "Scroll ↓" "ctrl+u" 'scroll-up "Scroll ↑"
         "ctrl+f" 'scroll-down "Page ↓" "ctrl+b" 'scroll-up "Page ↑"
         "home" (lambda () (move-to! bol)) "Line Start" "end" (lambda () (move-to! last-char)) "Line End")
   (define-char-scheme! 'helix "Helix" "Helix's: selection first, every motion on every selection" helix-keymap)))
