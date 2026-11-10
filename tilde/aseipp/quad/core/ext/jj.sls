;; jj.sls -- Jujutsu: what changed, and who changed it, beside the text
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; For a buffer whose file is in a jj repository (a directory above it has
;; .jj), the gutter marks the lines that differ from the file in jj-diff-base
;; (@-, the change before the working copy's, by default): added ▎, changed
;; ▎ in another color, deleted ▔ on the line after. The marks follow the
;; buffer as it is edited, saved or not: the diff is the editor's own
;; (kernel/diff), against the base's text, which jj gives once. The status
;; line shows the working copy's change -- its ID, bookmarks, description,
;; and whether it is empty or conflicted -- and jj-blame adds a gutter of
;; who last changed each line. `space g` has the rest: n and p go to the
;; next and previous change, d shows one's diff, r puts it back as the base
;; has it, b toggles blame, a says who changed the line, s and l show jj
;; status and jj log, g looks again. Vim's keys have ]c and [c for the
;; next and previous change, as vim-gitgutter does; Helix's ]g and [g.
;;
;; jj-program is the jj that runs (PATH's, by default), always in the
;; background. Nothing here changes the repository: the base and blame are
;; read with --ignore-working-copy (they come from committed changes, which
;; the working copy cannot change), and the working copy's change with
;; --no-integrate-operation, which snapshots the working copy to see it as
;; it is without recording that in the operation log. A repository that
;; changes elsewhere (jj run in a terminal) is noticed by its operation
;; heads changing, checked after commands and when a window is focused.
(library (quad ext jj)
  (export jj-root jj-info jj-hunks jj-refresh!)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display) (quad server)
          (only (quad native) diff-base diff-base-lines diff-base-block diff-hunks))

  (define-variable jj-program "jj" "The jj command the jj extension runs.")
  (define-variable jj-diff-base "@-" "The revision whose files the gutter marks changes from.")
  (define-variable jj-gutter #t "Whether the gutter marks lines changed since jj-diff-base.")
  (define-variable jj-blame #f "Whether the gutter shows who last changed each line.")

  ;; ---------------------------------------------------------------------------
  ;; Running jj

  ;; Run jj with args in the repository at root; then (done ok? output
  ;; errors).
  (define (jj! root args done)
    (guard (e [#t (done #f "" (condition->string e))])
      (run-program! (append (list (get-var 'jj-program) "--no-pager" "--color=never" "-R" root) args)
                    root '()
                    (lambda (status out err) (done (= status 0) out err)))))

  ;; A fileset naming the one file at path, relative to the root.
  (define (file-pattern rel)
    (string-append "root-file:\""
                   (apply string-append (map (lambda (c) (case c [(#\") "\\\""] [(#\\) "\\\\"] [else (string c)]))
                                             (string->list rel)))
                   "\""))

  ;; jj's first error line, for a message.
  (define (first-error err)
    (let ([lines (filter (lambda (l) (string-prefix? "Error" l)) (string-split err #\newline))])
      (if (pair? lines) (car lines) (string-trim err))))

  ;; ---------------------------------------------------------------------------
  ;; Repositories

  ;; root: the workspace's directory; heads: its operation heads'
  ;; directory, whose time changes with every operation; stamp: that time
  ;; when last looked at; info: the working copy's change, an alist, or #f.
  (define-record-type repo
    (fields root heads (mutable stamp) (mutable info) (mutable busy?) (mutable again?)))

  (define repos (make-hashtable string-hash string=?))

  ;; The directory above path with .jj in it, or #f.
  (define (find-root path)
    (find (lambda (d) (file-directory? (path-join d ".jj"))) (ancestor-dirs (path-dirname path))))

  ;; Where a workspace's repository is: .jj/repo, or (another workspace's)
  ;; the path in it.
  (define (repo-dir root)
    (let ([r (path-join root ".jj/repo")])
      (if (file-directory? r)
          r
          (let ([p (guard (e [#t #f]) (string-trim (read-file-string r)))])
            (and p (if (string-prefix? "/" p) p (path-join (path-join root ".jj") p)))))))

  (define (heads-stamp heads)
    (guard (e [#t #f])
      (let ([t (file-modification-time heads)]) (cons (time-second t) (time-nanosecond t)))))

  (define (repo-at root)
    (or (hashtable-ref repos root #f)
        (let* ([d (repo-dir root)]
               [r (make-repo root (and d (path-join d "op_heads/heads")) #f #f #f #f)])
          (hashtable-set! repos root r)
          r)))

  ;; The repository's root that buffer b's file is in, or #f.
  (define (jj-root b)
    (let ([known (buffer-local b 'jj-root 'unknown)])
      (if (eq? known 'unknown)
          (let ([root (and (buffer-path b) (find-root (buffer-path b)))])
            (buffer-local-set! b 'jj-root root)
            root)
          known)))

  (define (relative-path root path)
    (let ([prefix (string-append root "/")])
      (if (string-prefix? prefix path) (substring path (string-length prefix) (string-length path)) path)))

  ;; The working copy's change in b's repository: an alist of id,
  ;; bookmarks, description, conflict?, empty?; or #f.
  (define (jj-info b)
    (let ([root (jj-root b)]) (and root (repo-info (repo-at root)))))

  (define info-template
    (string-append "change_id.shortest(8) ++ \"\\x1f\" ++ bookmarks.join(\" \") ++ \"\\x1f\" ++ "
                   "description.first_line() ++ \"\\x1f\" ++ if(conflict, \"c\") ++ \"\\x1f\" ++ if(empty, \"e\")"))

  (define (refresh-info! r)
    (if (repo-busy? r)
        (repo-again?-set! r #t)
        (begin
          (repo-busy?-set! r #t)
          (jj! (repo-root r) (list "--no-integrate-operation" "log" "-r" "@" "--no-graph" "-T" info-template)
               (lambda (ok? out err)
                 (repo-busy?-set! r #f)
                 (repo-info-set!
                  r (and ok?
                         (let ([f (string-split out #\x1f)])
                           (and (= (length f) 5)
                                (list (cons 'id (list-ref f 0)) (cons 'bookmarks (list-ref f 1))
                                      (cons 'description (list-ref f 2))
                                      (cons 'conflict? (string=? (list-ref f 3) "c"))
                                      (cons 'empty? (string=? (list-ref f 4) "e")))))))
                 (when (repo-again? r) (repo-again?-set! r #f) (refresh-info! r)))))))

  ;; ---------------------------------------------------------------------------
  ;; Bases: the file as jj-diff-base has it, to diff a buffer against
  ;;
  ;; A buffer's 'jj-base is #f until jj answers, then the base (a diff-base
  ;; from kernel/diff), 'new (the file is not in the base, but jj tracks
  ;; it: every line is added) or 'none (no marks: jj does not track it, or
  ;; failed).

  (define (refresh-base! b)
    (let ([root (jj-root b)])
      (when root
        (if (buffer-local b 'jj-fetching #f)
            (buffer-local-set! b 'jj-again #t)
            (let ([rel (relative-path root (buffer-path b))] [rev (get-var 'jj-diff-base b)])
              (buffer-local-set! b 'jj-fetching #t)
              (jj! root (list "--ignore-working-copy" "file" "show" "-r" rev "--" (file-pattern rel))
                   (lambda (ok? out err)
                     (define (got! base)
                       (buffer-local-set! b 'jj-fetching #f)
                       (buffer-local-set! b 'jj-base base)
                       (buffer-local-set! b 'jj-hunks #f)
                       (buffer-local-set! b 'jj-blame-lines #f)
                       (when (get-var 'jj-blame b) (refresh-blame! b))
                       (when (buffer-local b 'jj-again #f)
                         (buffer-local-set! b 'jj-again #f)
                         (refresh-base! b)))
                     (cond
                      [ok? (got! (diff-base out))]
                      [(string-contains err "No such path")
                       ;; Not in the base: new, if the working copy has it.
                       (jj! root (list "--no-integrate-operation" "file" "list" "-r" "@" "--" (file-pattern rel))
                            (lambda (ok? out err)
                              (got! (if (and ok? (not (string=? (string-trim out) ""))) 'new 'none))))]
                      [else (got! 'none)]))))))))

  ;; b's hunks against its base, as a vector of #(old-start old-length
  ;; new-start new-length), worked out again only when its text changes;
  ;; #f with no base.
  (define (jj-hunks b)
    (let ([base (buffer-local b 'jj-base #f)] [t (buffer-text b)])
      (cond
       [(not (and base (get-var 'jj-gutter b))) #f]
       [(eq? base 'none) #f]
       [(eq? base 'new) (vector (vector 0 0 0 (text-line-count t)))]
       [else
        (let ([cached (buffer-local b 'jj-hunks #f)] [v (text-version t)])
          (if (and cached (eqv? (car cached) v))
              (cdr cached)
              (let ([hs (diff-hunks base (text-rope t))])
                (buffer-local-set! b 'jj-hunks (cons v hs))
                hs)))])))

  (define (hunk-old-start h) (vector-ref h 0))
  (define (hunk-old-len h) (vector-ref h 1))
  (define (hunk-new-start h) (vector-ref h 2))
  (define (hunk-new-len h) (vector-ref h 3))

  ;; The hunk that line is in, or that was deleted just above it; #f.
  (define (hunk-at hs line)
    (let loop ([lo 0] [hi (vector-length hs)])
      (if (>= lo hi)
          #f
          (let* ([mid (quotient (+ lo hi) 2)] [h (vector-ref hs mid)]
                 [s (hunk-new-start h)] [e (+ s (max 1 (hunk-new-len h)))])
            (cond
             [(< line s) (loop lo mid)]
             [(>= line e) (loop (+ mid 1) hi)]
             [else h])))))

  ;; The base's line that b's line was, or #f if it is in a hunk: the last
  ;; hunk starting at or before it, found by a binary search, says, as the
  ;; lines after a hunk are those after its old lines.
  (define (base-line hs line)
    (let loop ([lo 0] [hi (vector-length hs)])
      (if (< lo hi)
          (let ([mid (quotient (+ lo hi) 2)])
            (if (<= (hunk-new-start (vector-ref hs mid)) line) (loop (+ mid 1) hi) (loop lo mid)))
          ;; lo hunks start at or before line.
          (cond
           [(= lo 0) line]
           [else
            (let* ([h (vector-ref hs (- lo 1))] [after (+ (hunk-new-start h) (hunk-new-len h))])
              (and (>= line after) (+ (hunk-old-start h) (hunk-old-len h) (- line after))))]))))

  ;; ---------------------------------------------------------------------------
  ;; Blame: who last changed each of the base's lines

  (define blame-template
    (string-append "commit.change_id().shortest(8) ++ \"\\x1f\" ++ commit.author().name() ++ \"\\x1f\" ++ "
                   "commit.author().timestamp().ago() ++ \"\\x1f\" ++ commit.description().first_line() ++ \"\\n\""))

  (define (refresh-blame! b)
    (let ([root (jj-root b)] [base (buffer-local b 'jj-base #f)])
      (when (and root base (not (memq base '(new none))))
        (jj! root (list "--ignore-working-copy" "file" "annotate" "-r" (get-var 'jj-diff-base b) "-T" blame-template
                        (relative-path root (buffer-path b)))
             (lambda (ok? out err)
               (buffer-local-set!
                b 'jj-blame-lines
                ;; Each base line's (label id author when description),
                ;; the label as the gutter shows it; #f for a line jj
                ;; said nothing sensible of.
                (if ok?
                    (list->vector
                     (map (lambda (l)
                            (let ([f (string-split l #\x1f)])
                              (and (= (length f) 4)
                                   (cons (string-clip (string-append (car f) " " (cadr f)) (- blame-width 1)) f))))
                          (filter (lambda (l) (not (string=? l ""))) (string-split out #\newline))))
                    (vector))))))))

  ;; Line's blame in b: (label id author when description), or #f (changed
  ;; since the base, or not known yet).
  (define (blame-entry b line)
    (let ([lines (buffer-local b 'jj-blame-lines #f)] [hs (jj-hunks b)])
      (and lines hs
           (let ([l (base-line hs line)])
             (and l (< l (vector-length lines)) (vector-ref lines l))))))

  ;; Line's blame in b: (id author when description), or #f.
  (define (blame-of b line)
    (let ([e (blame-entry b line)]) (and e (cdr e))))

  ;; ---------------------------------------------------------------------------
  ;; Looking again

  ;; Fetch b's base and its repository's working copy again.
  (define (jj-refresh! b)
    (let ([root (jj-root b)])
      (when root
        (let ([r (repo-at root)])
          (repo-stamp-set! r (and (repo-heads r) (heads-stamp (repo-heads r))))
          (refresh-info! r)
          (refresh-base! b)))))

  ;; If b's repository has had operations since it was looked at, look at
  ;; it, and at every buffer in it, again.
  (define (check! b)
    (let ([root (and b (jj-root b))])
      (when root
        (let* ([r (repo-at root)] [stamp (and (repo-heads r) (heads-stamp (repo-heads r)))])
          (cond
           [(not (equal? stamp (repo-stamp r)))
            (repo-stamp-set! r stamp)
            (refresh-info! r)
            (for-each (lambda (x) (when (equal? (jj-root x) root) (refresh-base! x))) (buffers))]
           ;; No base yet: fetch it, unless that is under way (opening a
           ;; file and showing it both come here, one after the other).
           [(not (or (buffer-local b 'jj-base #f) (buffer-local b 'jj-fetching #f)))
            (unless (or (repo-info r) (repo-busy? r)) (refresh-info! r))
            (refresh-base! b)])))))

  (define last-check 0)
  (define (check-soon! b)
    (let ([now (real-time)])
      (when (> (- now last-check) 500)
        (set! last-check now)
        (check! b))))

  ;; ---------------------------------------------------------------------------
  ;; Commands

  (define (cur) (current-buffer))
  (define (cursor-line b) (text-line-of (buffer-text b) (sel-range-start (view-primary (current-view)))))

  (define (hunks-or-say b)
    (let ([hs (jj-hunks b)])
      (cond
       [(not (jj-root b)) (message "Not in a jj repository") #f]
       [(not hs) (message "Nothing from jj yet") #f]
       [(= 0 (vector-length hs)) (message "No changes since ~a" (get-var 'jj-diff-base b)) #f]
       [else hs])))

  ;; The next (dir 1) or previous (-1) hunk from the cursor's line, round
  ;; the end.
  (define (goto-hunk! dir)
    (let* ([b (cur)] [hs (hunks-or-say b)])
      (when hs
        (let* ([line (cursor-line b)] [starts (map hunk-new-start (vector->list hs))]
               [after (filter (lambda (s) (> s line)) starts)]
               [before (filter (lambda (s) (< s line)) starts)]
               [target (if (> dir 0)
                           (if (pair? after) (car after) (car starts))
                           (if (pair? before) (car (last-pair before)) (car (last-pair starts))))])
          (goto-line! (+ 1 (min target (- (text-line-count (buffer-text b)) 1))))))))

  (define (hunk-here b)
    (let ([hs (hunks-or-say b)])
      (and hs (or (hunk-at hs (cursor-line b)) (begin (message "No change on this line") #f)))))

  (define (old-lines b h)
    (let ([base (buffer-local b 'jj-base #f)])
      (if (and base (not (symbol? base)) (> (hunk-old-len h) 0))
          (string-split (let ([s (diff-base-lines base (hunk-old-start h) (hunk-old-len h))])
                          (if (string-suffix? "\n" s) (substring s 0 (- (string-length s) 1)) s))
                        #\newline)
          '())))

  (define (new-lines b h)
    (let ([t (buffer-text b)])
      (map (lambda (i) (text-line-string t (+ i (hunk-new-start h))))
           (iota (hunk-new-len h)))))

  ;; The change at the cursor, as a diff, in a popup.
  (define (show-hunk!)
    (let* ([b (cur)] [h (hunk-here b)])
      (when h
        (let ([lines (append (map (lambda (l) (cons (string-append "- " l) 'diff.minus)) (old-lines b h))
                             (map (lambda (l) (cons (string-append "+ " l) 'diff.plus)) (new-lines b h)))])
          (show-popup! (make-popup (format "Change since ~a, line ~a" (get-var 'jj-diff-base b) (+ 1 (hunk-new-start h)))
                                   (lambda () lines) "esc hide"))))))

  ;; Put the change at the cursor back as the base has it.
  (define (revert-hunk!)
    (let* ([b (cur)] [h (hunk-here b)] [base (buffer-local b 'jj-base #f)])
      (when h
        (let* ([t (buffer-text b)] [n (text-line-count t)]
               [s (hunk-new-start h)] [e (+ s (hunk-new-len h))]
               ;; The same rule as diff-base-block: through the end, the
               ;; newline before stands for the lines.
               [range (cond
                       [(< e n) (cons (text-line-start t s) (text-line-start t e))]
                       [(> s 0) (cons (text-line-end t (- s 1)) (text-length t))]
                       [else (cons 0 (text-length t))])]
               [old (if (symbol? base) "" (diff-base-block base (hunk-old-start h) (hunk-old-len h)))])
          (buffer-edit! b (list (list (car range) (cdr range) old)))
          (message "Put back as ~a has it" (get-var 'jj-diff-base b))))))

  (define (annotate-line!)
    (let* ([b (cur)] [line (cursor-line b)] [f (blame-of b line)])
      (cond
       [(not (jj-root b)) (message "Not in a jj repository")]
       [f (message "~a ~a, ~a: ~a" (car f) (cadr f) (caddr f) (cadddr f))]
       [(and (jj-hunks b) (not (base-line (jj-hunks b) line))) (message "Changed since ~a" (get-var 'jj-diff-base b))]
       [(buffer-local b 'jj-blame-lines #f) (message "Nothing known about this line")]
       [else (refresh-blame! b) (message "Asking jj; again in a moment")])))

  (define (toggle-blame!)
    (let ([b (cur)])
      (set-local! 'jj-blame (not (get-var 'jj-blame b)) b)
      (when (and (get-var 'jj-blame b) (not (buffer-local b 'jj-blame-lines #f))) (refresh-blame! b))))

  ;; jj's output for args, in a read-only buffer named name.
  (define (show-jj! name args)
    (let ([b (cur)] [c (current-client)])
      (let ([root (jj-root b)])
        (if (not root)
            (message "Not in a jj repository")
            (jj! root args
                 (lambda (ok? out err)
                   (with-client-if-here c
                     (lambda ()
                       (if ok?
                           (show-text-buffer! name out 'text)
                           (message-error "jj: ~a" (first-error err)))))))))))

  (define jj-keymap
    (menu 'jj "jj"
          "n" 'jj-next-change "Next Change"
          "p" 'jj-previous-change "Previous Change"
          "d" 'jj-show-change "Show Change"
          "r" 'jj-revert-change "Put Back"
          "b" 'jj-blame "Blame"
          "a" annotate-line! "Who Changed This"
          "s" (lambda () (show-jj! "*jj status*" '("--no-integrate-operation" "status"))) "Status"
          "l" (lambda () (show-jj! "*jj log*" '("--no-integrate-operation" "log"))) "Log"
          "g" (lambda () (jj-refresh! (cur)) (message "Asking jj again")) "Look Again"))

  ;; ---------------------------------------------------------------------------
  ;; The gutters and the status line


  (define blame-width 20)

  (at-load
   (define-gutter! 'jj-changes 60
     (lambda (v) (if (jj-hunks (view-buffer v)) 1 0))
     (lambda (v line cur? w)
       (let* ([hs (jj-hunks (view-buffer v))] [h (and hs (hunk-at hs line))])
         (cond
          [(not h) #f]
          [(= 0 (hunk-new-len h)) (cons "▔" 'diff.minus)]
          [(= 0 (hunk-old-len h)) (cons "▎" 'diff.plus)]
          [else (cons "▎" 'diff.delta)]))))
   (define-gutter! 'jj-blame 20
     (lambda (v) (let ([b (view-buffer v)]) (if (and (get-var 'jj-blame b) (jj-hunks b)) blame-width 0)))
     (lambda (v line cur? w)
       (let ([e (blame-entry (view-buffer v) line)])
         (cons (if e (car e) "") 'ui.gutter.blame))))
   (define-status-segment! 'left
     (lambda (v)
       (let ([info (jj-info (view-buffer v))])
         (and info
              (cons (string-append
                     "  @ " (cdr (assq 'id info))
                     (let ([bm (cdr (assq 'bookmarks info))]) (if (string=? bm "") "" (string-append " " bm)))
                     (if (cdr (assq 'conflict? info)) " (conflict)" "")
                     (if (cdr (assq 'empty? info)) " (empty)" "")
                     (let ([d (cdr (assq 'description info))])
                       (if (string=? d "") "" (string-append " · " (string-clip d 30)))))
                    'ui.statusline.dim)))))
   (define-key space-keymap "g" jj-keymap "jj")
   (add-hook! 'find-file-hook (lambda (b) (check! b)))
   (add-hook! 'buffer-switch-hook (lambda (b) (check! b)))
   (add-hook! 'after-save-hook
              (lambda (b) (when (jj-root b) (refresh-info! (repo-at (jj-root b))) (check! b))))
   (add-hook! 'focus-in-hook (lambda () (check! (current-buffer))))
   (add-hook! 'post-command-hook (lambda (c) (check-soon! (current-buffer))))
   ;; Another base: every buffer's marks are from it now.
   (add-hook! 'variable-change-hook
              (lambda (name v)
                (when (eq? name 'jj-diff-base)
                  (for-each (lambda (b) (when (jj-root b) (refresh-base! b))) (buffers)))))
   (define-command 'jj-refresh "Ask jj again about the buffer's file and its repository" (lambda () (jj-refresh! (cur))))
   (define-command 'jj-next-change "Go to the next line changed since jj-diff-base" (lambda () (goto-hunk! 1)))
   (define-command 'jj-previous-change "Go to the previous line changed since jj-diff-base" (lambda () (goto-hunk! -1)))
   (define-command 'jj-show-change "Show the change at the cursor, as a diff" show-hunk!)
   (define-command 'jj-revert-change "Put the change at the cursor back as jj-diff-base has it" revert-hunk!)
   (define-command 'jj-blame "Show or hide who last changed each line" toggle-blame!)))
