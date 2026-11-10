;; vi.sls -- what Vim's and Helix's keys share: motions, counts, select, ex
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The key schemes vim.sls and helix.sls are built from this: positions
;; and motions over the current buffer's text (words as quad's word and
;; WORD units have them, lines, a character found in a line, the bracket
;; matching another); a cursor a character wide, as both show it; select
;; (Vim's visual mode, Helix's select mode), an anchor and a head the
;; selection covers, charwise or linewise; counts typed before a command;
;; layers that take any character (f, t, r); registers, which yanks,
;; deletes and puts use; macros and repeating, which replay keys;
;; searching both ways; and a prompt for ex commands (:w, :q, :e FILE, :N,
;; :reg), which both have.
(library (quad ext vi)
  (export vi-buffer vi-len bol eol last-char first-nonblank line-of line-start line-end last-line on-line
          word-forward word-backward word-end find-in-line matching-bracket
          cursor-sel head set-cursors! vi-move-cursors!
          select-kind select-anchor select-start! select-stop! select-set-head! selecting?
          take-count! count-digit! count-pending? clear-count!
          char-keymap enclosure-of enclosure-at
          yank! register-key! register-store! register-fetch show-registers!
          take-register! recording record-start! record-stop! play-macro! run-macro!
          change-made! repeat-change!
          vi-search-prompt! search-step
          ex-prompt! ex-run!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display))

  ;; ---------------------------------------------------------------------------
  ;; Positions

  (define (vi-buffer) (current-buffer))
  (define (t*) (buffer-text (current-buffer)))
  (define (vi-len) (text-length (t*)))
  (define (line-of p) (text-line-of (t*) p))
  (define (line-start line) (text-line-start (t*) line))
  (define (line-end line) (text-line-end (t*) line))
  (define (bol p) (line-start (line-of p)))
  (define (eol p) (line-end (line-of p)))
  ;; The last line, as Vim counts them: a newline ends a line rather than
  ;; starting another, so the empty end after the text's last newline is
  ;; not one.
  (define (last-line)
    (let ([n (text-line-count (t*))])
      (if (and (> n 1) (= (line-start (- n 1)) (vi-len))) (- n 2) (- n 1))))

  ;; p, or the last line's start if p is past it.
  (define (on-line p) (if (> (line-of p) (last-line)) (line-start (last-line)) p))

  ;; The last character of p's line, as a cursor rests on it: its start,
  ;; on an empty line.
  (define (last-char p) (max (bol p) (- (eol p) 1)))

  (define (blank? c) (or (char=? c #\space) (char=? c #\tab)))

  (define (first-nonblank p)
    (let ([e (eol p)])
      (let loop ([i (bol p)])
        (if (and (< i e) (blank? (text-ref (t*) i))) (loop (+ i 1)) i))))

  ;; quad's units (selection.sls): 'word for Vim's words, 'big-word for
  ;; its WORDs.
  (define (unit-current mode p)
    (let ([m (find-selection-mode mode)] [n (vi-len)])
      (and (< p n) ((selection-mode-current m) (vi-buffer) (cons p (+ p 1))))))
  (define (unit-move mode p dir)
    (let ([m (find-selection-mode mode)] [n (vi-len)])
      ((selection-mode-move m) (vi-buffer) (cons p (min n (+ p 1))) dir)))

  ;; Where the next word starts, after p (the text's end, if none does).
  (define (word-forward mode p)
    (let ([c (unit-current mode p)])
      (cond
       [(and c (> (car c) p)) (car c)]
       [else (let ([n (unit-move mode p 'next)]) (if (and n (> (car n) p)) (car n) (vi-len)))])))

  ;; Where the word p is in starts, if p is past its start; else where the
  ;; one before it does.
  (define (word-backward mode p)
    (let ([c (unit-current mode p)])
      (if (and c (< (car c) p) (<= p (cdr c)))
          (car c)
          (let ([prev (unit-move mode p 'previous)])
            (if (and prev (< (car prev) p)) (car prev) 0)))))

  ;; Where the word p is in ends (its last character), if p is before
  ;; that; else where the next one does.
  (define (word-end mode p)
    (let ([c (unit-current mode p)])
      (if (and c (> (- (cdr c) 1) p))
          (- (cdr c) 1)
          (let ([n (unit-move mode p 'next)]) (if n (- (cdr n) 1) p)))))

  ;; The nearest ch on p's line after p (dir 1) or before it (-1), or #f.
  (define (find-in-line p ch dir)
    (let ([s (bol p)] [e (eol p)])
      (let loop ([i (+ p dir)])
        (cond [(or (< i s) (>= i e)) #f]
              [(char=? (text-ref (t*) i) ch) i]
              [else (loop (+ i dir))]))))

  ;; The bracket matching the one at p, or the first after it on its line;
  ;; #f if there is none.
  (define (matching-bracket p)
    (let* ([pairs '((#\( . #\)) (#\[ . #\]) (#\{ . #\}))]
           [e (eol p)]
           [at (let loop ([i p])
                 (cond [(>= i e) #f]
                       [(exists (lambda (pr) (or (char=? (text-ref (t*) i) (car pr)) (char=? (text-ref (t*) i) (cdr pr)))) pairs) i]
                       [else (loop (+ i 1))]))])
      (and at
           (let* ([c (text-ref (t*) at)]
                  [open (find (lambda (pr) (char=? (car pr) c)) pairs)]
                  [close (find (lambda (pr) (char=? (cdr pr) c)) pairs)]
                  [n (vi-len)])
             (if open
                 (let loop ([i (+ at 1)] [depth 0])
                   (cond [(>= i n) #f]
                         [(char=? (text-ref (t*) i) (car open)) (loop (+ i 1) (+ depth 1))]
                         [(char=? (text-ref (t*) i) (cdr open)) (if (= depth 0) i (loop (+ i 1) (- depth 1)))]
                         [else (loop (+ i 1) depth)]))
                 (let loop ([i (- at 1)] [depth 0])
                   (cond [(< i 0) #f]
                         [(char=? (text-ref (t*) i) (cdr close)) (loop (- i 1) (+ depth 1))]
                         [(char=? (text-ref (t*) i) (car close)) (if (= depth 0) i (loop (- i 1) (- depth 1)))]
                         [else (loop (- i 1) depth)])))))))

  ;; ---------------------------------------------------------------------------
  ;; The cursor, and select

  ;; A cursor a character wide at p (none wide at the text's end).
  (define (cursor-sel p) (make-sel p (min (vi-len) (+ p 1))))

  ;; Where the primary cursor is: select's head, while selecting.
  (define (head)
    (if (selecting?) (view-local (current-view) 'vi-head 0) (sel-start (primary))))

  (define (set-cursors! ps)
    (set-sels! (vi-buffer) (map (lambda (p) (cursor-sel (clamp p 0 (vi-len)))) ps)))

  ;; Move every cursor (or, selecting, the head) to (f p).
  (define (vi-move-cursors! f)
    (if (selecting?)
        (select-set-head! (clamp (f (head)) 0 (vi-len)))
        (set-cursors! (map (lambda (s) (f (sel-start s))) (sels-of (vi-buffer))))))

  ;; Select: #f, 'char or 'line; from select-anchor to the head.
  (define (select-kind) (view-local (current-view) 'vi-select #f))
  (define (selecting?) (and (select-kind) #t))
  (define (select-anchor) (view-local (current-view) 'vi-anchor 0))

  (define (select-start! kind)
    (let ([p (sel-start (primary))])
      (view-local-set! (current-view) 'vi-select kind)
      (view-local-set! (current-view) 'vi-anchor p)
      (select-set-head! p)))

  ;; Stop selecting: the cursor where the head is.
  (define (select-stop!)
    (when (selecting?)
      (let ([p (head)])
        (view-local-set! (current-view) 'vi-select #f)
        (set-cursors! (list (min p (vi-len)))))))

  (define (select-set-head! p)
    (view-local-set! (current-view) 'vi-head p)
    (let* ([a (select-anchor)] [lo (min a p)] [hi (max a p)])
      (set-sels! (vi-buffer)
                 (list (if (eq? (select-kind) 'line)
                           (make-sel (bol lo) (min (vi-len) (+ (eol hi) 1)))
                           (make-sel lo (min (vi-len) (+ hi 1))))))))

  ;; ---------------------------------------------------------------------------
  ;; Counts: digits typed before a command, how many times to do it

  (define (count-pending?) (and (client-local (current-client) 'vi-count #f) #t))
  (define (clear-count!) (client-local-set! (current-client) 'vi-count #f))

  (define (count-digit! d)
    (let ([n (client-local (current-client) 'vi-count #f)])
      (client-local-set! (current-client) 'vi-count (+ d (* 10 (or n 0))))
      (message "~a" (client-local (current-client) 'vi-count #f))))

  ;; The count typed (default if none), forgotten.
  (define take-count!
    (case-lambda
     [() (take-count! 1)]
     [(default)
      (let ([n (client-local (current-client) 'vi-count #f)])
        (clear-count!)
        (or n default))]))

  ;; ---------------------------------------------------------------------------
  ;; Layers that take any character

  (define printable
    (map (lambda (i) (integer->char (+ i 32))) (iota 95)))

  ;; A layer of every printable key: (proc char) for the one pressed.
  (define (char-keymap name title proc)
    (let ([km (make-keymap name title)])
      (for-each (lambda (c)
                  (define-key km (if (char=? c #\space) "space" (string c)) (lambda () (proc c)) (string c)))
                printable)
      km))

  ;; The enclosure (open close) a typed character stands for: either of a
  ;; pair, or a quote; b and B for ( and {, as Vim has them.
  (define (enclosure-of c)
    (case c
      [(#\( #\) #\b) '("(" ")")]
      [(#\[ #\]) '("[" "]")]
      [(#\{ #\} #\B) '("{" "}")]
      [(#\< #\>) '("<" ">")]
      [(#\" #\' #\`) (list (string c) (string c))]
      [else #f]))

  ;; The innermost (open . close) around [s, e): on an opening bracket, the
  ;; pair it opens; on a closing one, the pair it closes.
  (define (enclosure-at s e open close)
    (let ([b (vi-buffer)] [c (and (< s (vi-len)) (text-ref (t*) s))])
      (cond
       [(and c (not (string=? open close)) (char=? c (string-ref open 0))) (find-enclosure b (+ s 1) (+ s 1) open close)]
       [(and c (not (string=? open close)) (char=? c (string-ref close 0))) (find-enclosure b s s open close)]
       [else (find-enclosure b s e open close)])))

  ;; ---------------------------------------------------------------------------
  ;; Registers
  ;;
  ;; What yanks and deletes keep and puts put: the unnamed register, which
  ;; is quad's clipboard, unless "x before the command names another. a to
  ;; z keep what is put in them (A to Z add to it); 0 the last yank; 1 to 9
  ;; the last deletes of lines, older ones further down; - the last smaller
  ;; delete; _ keeps nothing; " + and * are the unnamed one. Each holds
  ;; texts -- Helix's, one for each selection; Vim's, one -- and whether
  ;; they are whole lines.

  (define registers (make-eqv-hashtable))
  (define last-linewise #f)             ; the clipboard's texts, if put there whole lines

  (define (register-name? c)
    (or (char<=? #\a c #\z) (char<=? #\A c #\Z) (char<=? #\0 c #\9) (memv c '(#\- #\_ #\" #\+ #\*))))
  (define (unnamed? r) (or (not r) (memv r '(#\" #\+ #\*))))
  (define (digit-register d) (integer->char (+ (char->integer #\0) d)))

  ;; "x: the register the next yank, delete or put uses.
  (define (register-key! c)
    (if (register-name? c)
        (client-local-set! (current-client) 'vi-register c)
        (message-error "No register ~a" c)))
  (define (register-pending?) (and (client-local (current-client) 'vi-register #f) #t))
  (define (take-register!)
    (let ([r (client-local (current-client) 'vi-register #f)])
      (client-local-set! (current-client) 'vi-register #f)
      r))

  ;; One register's contents added to another's: lines after lines, else
  ;; text after text.
  (define (register-append old new)
    (let ([lines? (or (cdr old) (cdr new))])
      (cons (if (and (= 1 (length (car old))) (= 1 (length (car new))))
                (let ([a (car (car old))])
                  (list (string-append a (if (and lines? (not (string-suffix? "\n" a)) (not (string=? a ""))) "\n" "")
                                       (car (car new)))))
                (append (car old) (car new)))
            lines?)))

  ;; Keep texts a command yanked (kind 'yank) or deleted ('delete).
  (define (register-store! texts linewise? kind)
    (let ([r (take-register!)] [v (cons texts linewise?)])
      (unless (eqv? r #\_)
        (cond
         [(unnamed? r)
          (cond
           [(eq? kind 'yank) (hashtable-set! registers #\0 v)]
           [(or linewise? (exists (lambda (s) (string-index s #\newline)) texts))
            (do ([i 9 (- i 1)]) ((< i 2))
              (let ([older (hashtable-ref registers (digit-register (- i 1)) #f)])
                (if older
                    (hashtable-set! registers (digit-register i) older)
                    (hashtable-delete! registers (digit-register i)))))
            (hashtable-set! registers #\1 v)]
           [else (hashtable-set! registers #\- v)])]
         [(char-upper-case? r)
          (let* ([k (char-downcase r)] [old (hashtable-ref registers k #f)])
            (hashtable-set! registers k (if old (register-append old v) v)))]
         [else (hashtable-set! registers r v)])
        ;; The unnamed register has it too, as Vim's points at the last used.
        (let ([v (if (and r (char-upper-case? r)) (hashtable-ref registers (char-downcase r) v) v)])
          (clipboard-push! (car v))
          (set! last-linewise (and (cdr v) (car v)))))))

  ;; Vim's: text yanked or deleted, linewise? whole lines.
  (define (yank! text linewise? kind) (register-store! (list text) linewise? kind))

  ;; What a put puts: (texts . linewise?) from the register named, else the
  ;; unnamed one; #f if it is empty.
  (define (register-fetch)
    (let ([r (take-register!)])
      (if (unnamed? r) (register-fetch-unnamed) (hashtable-ref registers (char-downcase r) #f))))

  ;; The registers with something in them, in a popup (:registers).
  (define (show-registers!)
    (define (shown v)
      (let* ([s (string-join (car v) " | ")]
             [s (list->string (apply append (map (lambda (c) (if (char=? c #\newline) (string->list "⏎") (list c)))
                                                 (string->list s))))])
        (if (> (string-length s) 70) (string-append (substring s 0 69) "…") s)))
    (let ([lines (filter-map
                  (lambda (r)
                    (let ([v (if (char=? r #\") (register-fetch-unnamed) (hashtable-ref registers r #f))])
                      (and v (cons (format "\"~a  ~a~a" r (if (cdr v) "lines " "") (shown v)) 'ui.text))))
                  (append (list #\" #\0 #\1 #\2 #\3 #\4 #\5 #\6 #\7 #\8 #\9 #\-)
                          (map (lambda (i) (integer->char (+ i (char->integer #\a)))) (iota 26))))])
      (show-popup! (make-popup "Registers" (lambda () (if (null? lines) (list (cons "None yet" 'ui.text)) lines))
                               "esc hide"))))

  (define (register-fetch-unnamed)
    (let ([top (clipboard-top)]) (and top (cons top (and last-linewise (equal? top last-linewise) #t)))))

  ;; ---------------------------------------------------------------------------
  ;; Macros and repeating
  ;;
  ;; Both replay keys. A macro is the keys pressed (and the text pasted)
  ;; while it was recorded, kept by a register's name (a to z; A to Z add to
  ;; one). A change to repeat is the keys from normal mode with nothing
  ;; pending to normal mode again -- an operator and its motion, a put, an
  ;; insert and what was typed in it -- that a command making a change
  ;; marked as one (change-made!). Replayed keys are not recorded again,
  ;; and those a repeat replays leave the change to repeat as it was; a
  ;; macro's changes are changes like any others.

  (define macros (make-eqv-hashtable))
  (define last-macro #f)

  (define (local k) (client-local (current-client) k #f))
  (define (local-set! k v) (client-local-set! (current-client) k v))

  ;; The register being recorded into, or #f.
  (define (recording) (local 'vi-recording))

  (define (record-start! c)
    (if (or (char-alphabetic? c) (char=? c #\@))
        (begin (local-set! 'vi-recording c) (local-set! 'vi-recorded '()))
        (message-error "Macros go in registers a to z")))

  ;; The key that stopped the recording was recorded last, and is left out.
  (define (record-stop!)
    (let* ([r (recording)] [k (char-downcase r)]
           [keys (reverse (let ([l (local 'vi-recorded)]) (if (pair? l) (cdr l) '())))])
      (local-set! 'vi-recording #f)
      (hashtable-set! macros k (if (char-upper-case? r) (append (hashtable-ref macros k '()) keys) keys))
      (set! last-macro k)
      (message "Recorded @~a: ~a key~a" k (length keys) (if (= 1 (length keys)) "" "s"))))

  ;; Replay events: kind 'macro, or 'repeat for a change repeated.
  (define (replay! events kind)
    (let ([depth (or (local 'vi-replay-depth) 0)] [was (local 'vi-replay)])
      (if (>= depth 100)
          (message-error "Macros run within each other too deep")
          (dynamic-wind
            (lambda () (local-set! 'vi-replay kind) (local-set! 'vi-replay-depth (+ depth 1)))
            (lambda () (for-each handle-event events))
            (lambda () (local-set! 'vi-replay was) (local-set! 'vi-replay-depth depth))))))

  ;; Vim's @c: @ again for the last one recorded or run.
  (define (play-macro! c)
    (if (and (char=? c #\@) (not last-macro))
        (begin (take-count!) (message-error "No macro yet"))
        (run-macro! (if (char=? c #\@) last-macro c))))

  ;; The macro in register c, as many times as the count.
  (define (run-macro! c)
    (let* ([n (take-count!)] [k (char-downcase c)] [keys (hashtable-ref macros k #f)])
      (cond
       [(not keys) (message-error "No macro in ~a" k)]
       [else (set! last-macro k)
             (do ([i 0 (+ i 1)]) ((= i n)) (replay! keys 'macro))])))

  (define (change-made!) (unless (eq? (local 'vi-replay) 'repeat) (local-set! 'vi-changed #t)))

  ;; The count a change was typed with: digits before it, or after its
  ;; register ("a2dw).
  (define (without-count events)
    (define (key? e pred) (and (key-event? e) (pred (key-event->spec e))))
    (define (digit? s) (and (= 1 (string-length s)) (char-numeric? (string-ref s 0))))
    (let loop ([l events] [acc '()])
      (cond
       [(null? l) (reverse acc)]
       [(key? (car l) digit?) (loop (cdr l) acc)]
       [(and (key? (car l) (lambda (s) (string=? s "\""))) (pair? (cdr l)))
        (loop (cddr l) (cons* (cadr l) (car l) acc))]
       [else (append (reverse acc) l)])))

  ;; Repeat the last change; n: a count to do it with instead of its own.
  (define (repeat-change! n)
    (let ([events (local 'vi-last-change)])
      (cond
       [(not events) (message "No change to repeat yet")]
       [n (local-set! 'vi-count n) (replay! (without-count events) 'repeat)]
       [else (replay! events 'repeat)])))

  ;; Normal mode, nothing pending: where one command's keys end and the
  ;; next's begin.
  (define (at-rest?)
    (let ([v (current-view)])
      (and v (eq? (view-input-mode v) 'normal) (not (active-layer)) (not (current-prompt))
           (not (count-pending?)) (not (register-pending?)) (not (selecting?)))))

  (define (vi-scheme?) (let ([s (current-key-scheme)]) (and s (memq (key-scheme-name s) '(vim helix)) #t)))

  ;; Every key pressed, and text pasted, before it is handled.
  (define (note-event! ev)
    (when (and (current-client) (vi-scheme?)
               (or (and (key-event? ev) (key-event-press? ev)) (paste-event? ev)))
      (let ([replay (local 'vi-replay)])
        (when (and (recording) (not replay))
          (local-set! 'vi-recorded (cons ev (or (local 'vi-recorded) '()))))
        (unless (eq? replay 'repeat)
          (when (at-rest?)
            (when (local 'vi-changed) (local-set! 'vi-last-change (reverse (local 'vi-keys))))
            (local-set! 'vi-keys '())
            (local-set! 'vi-changed #f))
          (local-set! 'vi-keys (cons ev (or (local 'vi-keys) '())))))))

  ;; ---------------------------------------------------------------------------
  ;; Search

  ;; Ask for a regular expression and search for it, dir 1 forwards or -1
  ;; back; then (found range) with the match.
  (define (vi-search-prompt! dir found)
    (let ([b (vi-buffer)] [from (head)])
      (read-string-prompt (if (> dir 0) "/" "?")
                          (lambda (pat)
                            (unless (string=? pat "")
                              (search-pattern-set! b pat #t)
                              (buffer-local-set! b 'vi-search-dir dir)
                              (let ([m (search-from b (if (> dir 0) (+ from 1) (- from 1)) dir)])
                                (cond
                                 [m (found m)]
                                 [(search-error b) => (lambda (why) (message-error "Not a pattern: ~a" why))]
                                 [else (message-error "No match for ~s" pat)])))))))

  ;; The next match of the last search from p: the way it went (again?), or
  ;; the other way; #f if there is none.
  (define (search-step p again?)
    (let* ([b (vi-buffer)] [dir (buffer-local b 'vi-search-dir 1)] [dir (if again? dir (- dir))])
      (and (search-pattern b) (search-from b (if (> dir 0) (+ p 1) (- p 1)) dir))))

  ;; ---------------------------------------------------------------------------
  ;; Ex commands

  (define (ex-prompt!) (read-string-prompt ":" ex-run!))

  ;; Run an ex command line: w [FILE], q, q!, wq, x, wa, qa, e FILE, e!, N
  ;; (a line), bn, bp, bd, sp, vs, noh, reg, set nu, set nonu; else a command of
  ;; quad's by name.
  (define (ex-run! line)
    (let* ([line (string-trim line)]
           [sp (string-index line #\space)]
           [cmd (if sp (substring line 0 sp) line)]
           [arg (if sp (string-trim (substring line sp (string-length line))) #f)]
           [b (vi-buffer)])
      (cond
       [(string=? cmd "") (void)]
       [(string->number cmd) => (lambda (n) (goto-line! n))]
       [(member cmd '("w" "write"))
        (when arg (buffer-path-set! b (absolute-path (expand-home arg))))
        (run-command 'save-force)]
       [(member cmd '("wq" "x" "xit")) (run-command 'save) (run-command 'quit)]
       [(member cmd '("q" "quit")) (run-command 'quit)]
       [(member cmd '("q!" "quit!" "qa!" "cq")) (run-command 'quit-no-save)]
       [(string=? cmd "qa") (run-command 'quit)]
       [(string=? cmd "wa") (run-command 'save-all)]
       [(and (member cmd '("e" "edit")) arg) (switch-to-buffer! (open-file! (expand-home arg)))]
       [(string=? cmd "e!") (run-command 'reload)]
       [(member cmd '("bn" "bnext")) (run-command 'buffer-next)]
       [(member cmd '("bp" "bprevious")) (run-command 'buffer-previous)]
       [(member cmd '("bd" "bdelete")) (run-command 'buffer-close)]
       [(member cmd '("sp" "split")) (run-command 'split-below)]
       [(member cmd '("vs" "vsplit")) (run-command 'split-right)]
       [(member cmd '("noh" "nohlsearch")) (search-pattern-set! b #f)]
       [(member cmd '("reg" "registers" "di" "display")) (show-registers!)]
       [(and (string=? cmd "set") arg (member arg '("nu" "number"))) (set-var! 'line-numbers #t)]
       [(and (string=? cmd "set") arg (member arg '("nonu" "nonumber"))) (set-var! 'line-numbers #f)]
       [(find-command (string->symbol line)) (run-command (string->symbol line))]
       [else (message-error "Not an editor command: ~a" line)])))

  (define (absolute-path p)
    (if (string-prefix? "/" p) p (path-join (current-directory) p)))

  ;; Leaving select (and a count, and a register) is what escape does here
  ;; too.
  (at-load
   (add-hook! 'escape-hook
              (lambda () (clear-count!) (take-register!) (when (selecting?) (select-stop!))))
   (add-hook! 'before-event-hook note-event!)
   (define-status-segment! 'left
     (lambda (v)
       (let ([r (client-local (view-client v) 'vi-recording #f)])
         (and r (cons (format " recording @~a " r) 'ui.statusline.insert)))))))
