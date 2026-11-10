;; commands.sls -- the standard commands, and the menus every scheme shares
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The commands are named, and keymaps bind them: the menus every key
;; scheme shares are here (space, ctrl+w for panes, insert mode, prompts);
;; the rest of each scheme's keys are its extension's (core/ext/ki.sls,
;; vim.sls, helix.sls). What the commands do is edit.sls's (editing) and
;; input.sls's (the mouse, pastes, scrolling).
(library (quad commands)
  (export
   ;; selection and movement
   move! select-mode! current-unit move-range
   ;; editing helpers for extensions
   edit-sels! selection-text sels-texts insert-at-cursors! enter-insert!
   exit-insert! gap-between line-indent indent-for-newline
   ;; keymaps
   enclosure-keymap space-keymap local-keymap bind layer menu
   editor-menu pick-menu context-menu pane-menu transform-keymap surround-keymap
   ;; enclosures, for key schemes
   enclosures find-enclosure surround! delete-surround! change-surround!
   ;; the mouse
   define-click-handler!
   ;; files and lines
   project-files load-init-file! init-file-path goto-line!
   ;; starting
   quad-version editor-init!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (only (quad native) project-files)
          (quad edit) (quad input))

  (at-load (edit-install!) (input-install!))

  ;; ---------------------------------------------------------------------------
  ;; Files, buffers and pickers

  ;; The working directory's files are what its ignore files do not
  ;; ignore (project-files, the kernel's: kernel/files/).

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

  ;; ---------------------------------------------------------------------------
  ;; Panes (client.sls)

  ;; Split the focused pane: the new one, showing what it shows, dir
  ;; ('right or 'below) of it.
  (define (split! dir)
    (split-pane! (current-client) dir))

  (define (close-pane!*)
    (unless (close-pane! (current-client)) (message "The only pane")))

  ;; Close every pane but the focused one.
  (define (only-pane!)
    (let ([c (current-client)])
      (let loop ()
        (let ([others (remq (client-focused-pane c) (client-panes c))])
          (when (pair? others)
            (let ([keep (client-focused-pane c)])
              (focus-pane! c (car others))
              (close-pane! c)
              (focus-pane! c keep)
              (loop)))))))

  ;; Focus the pane after (step 1) or before (-1) the focused one, around.
  (define (cycle-pane! step)
    (let* ([c (current-client)] [ps (client-panes c)] [n (length ps)]
           [i (list-index (lambda (p) (eq? p (client-focused-pane c))) ps)])
      (focus-pane! c (list-ref ps (mod (+ i step) n)))))

  ;; Focus the nearest pane in direction dir (left, right, up, down) of
  ;; the focused one, as last drawn.
  (define (focus-toward! dir)
    (let* ([c (current-client)] [here (pane-rect (client-focused-pane c))])
      (when here
        (let* ([center (lambda (r) (cons (+ (car r) (quotient (caddr r) 2)) (+ (cadr r) (quotient (cadddr r) 2))))]
               [me (center here)]
               [candidates
                (filter-map
                 (lambda (p)
                   (let ([r (pane-rect p)])
                     (and r (not (eq? p (client-focused-pane c)))
                          (let ([them (center r)])
                            (and (case dir
                                   [(left) (< (cadr r) (cadr here))]
                                   [(right) (> (cadr r) (cadr here))]
                                   [(up) (< (car r) (car here))]
                                   [(down) (> (car r) (car here))])
                                 (cons (+ (abs (- (car them) (car me))) (abs (- (cdr them) (cdr me)))) p))))))
                 (client-panes c))])
          (if (null? candidates)
              (message "No pane there")
              (focus-pane! c (cdar (sort (lambda (a b) (< (car a) (car b))) candidates))))))))

  ;; Give the focused pane more of its split (step > 0) or less.
  (define (resize-pane! step)
    (let* ([c (current-client)] [p (client-focused-pane c)]
           [parent (let walk ([n (client-layout c)])
                     (and (split? n)
                          (if (or (eq? (split-first n) p) (eq? (split-second n) p))
                              n
                              (or (walk (split-first n)) (walk (split-second n))))))])
      (if (not parent)
          (message "The only pane")
          (let ([delta (if (eq? (split-first parent) p) step (- step))])
            (split-ratio-set! parent (max 1/10 (min 9/10 (+ (split-ratio parent) delta))))))))

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

  (defcmd search "Search for text, selecting matches" (search-prompt! #f))
  (defcmd search-regex "Search for a regular expression, selecting matches" (search-prompt! #t))
  (defcmd search-this "Search for the selected text" (search! (selection-text (cur) (primary))))
  (defcmd search-repeat "Search for the last pattern again"
    (let ([p (buffer-local (cur) 'last-search #f)]) (if p (search! (car p) (cdr p)) (message "No previous search"))))

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
  (defcmd pick-key-scheme "Pick the way to edit: Ki's keys, Vim's, Helix's"
    (pick "Key Scheme"
          (map (lambda (name)
                 (let ([s (find-key-scheme name)])
                   (cons (format "~a  ~a~a" (key-scheme-title s) (key-scheme-doc s)
                                 (if (eq? s (current-key-scheme)) "  (in use)" ""))
                         name)))
               (key-scheme-names))
          (lambda (name) (set-var! 'key-scheme name) (message "Keys: ~a's" (key-scheme-title (find-key-scheme name))))))
  (defcmd split-right "Split the pane: another beside it, showing the same" (split! 'right))
  (defcmd split-below "Split the pane: another under it, showing the same" (split! 'below))
  (defcmd close-pane "Close the pane, unless it is the only one" (close-pane!*))
  (defcmd only-pane "Close every pane but this one" (only-pane!))
  (defcmd next-pane "Focus the next pane" (cycle-pane! 1))
  (defcmd previous-pane "Focus the previous pane" (cycle-pane! -1))
  (defcmd pane-left "Focus the pane to the left" (focus-toward! 'left))
  (defcmd pane-right "Focus the pane to the right" (focus-toward! 'right))
  (defcmd pane-up "Focus the pane above" (focus-toward! 'up))
  (defcmd pane-down "Focus the pane below" (focus-toward! 'down))
  (defcmd grow-pane "Give the pane more of its split" (resize-pane! 1/10))
  (defcmd shrink-pane "Give the pane less of its split" (resize-pane! -1/10))
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
      ;; A key scheme's own modes end too (Vim's visual, Helix's select).
      (run-hooks 'escape-hook)
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
  (defcmd cursor-left "Cursor left" (move-cursors! grapheme-before))
  (defcmd cursor-right "Cursor right" (move-cursors! grapheme-after))
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
  ;; The grapheme cluster before or after index c of string s.
  (define (string-grapheme-before s c)
    (if (<= c 0) 0 (grapheme-start (lambda (i) (string-ref s i)) (- c 1) 0)))
  (define (string-grapheme-after s c)
    (grapheme-end (lambda (i) (string-ref s i)) c (string-length s)))
  (defcmd prompt-delete-backward "Delete before the cursor"
    (prompt-edit! (lambda (in c)
                    (let ([b (string-grapheme-before in c)])
                      (values (string-append (substring in 0 b) (substring in c (string-length in))) b)))))
  (defcmd prompt-delete-forward "Delete after the cursor"
    (prompt-edit! (lambda (in c)
                    (let ([a (string-grapheme-after in c)])
                      (values (string-append (substring in 0 c) (substring in a (string-length in))) c)))))
  (defcmd prompt-delete-word "Delete the word before the cursor"
    (prompt-edit! (lambda (in c)
                    (let* ([i (let loop ([i c]) (if (and (> i 0) (char=? (string-ref in (- i 1)) #\space)) (loop (- i 1)) i))]
                           [i (let loop ([i i]) (if (and (> i 0) (not (memv (string-ref in (- i 1)) '(#\space #\/)))) (loop (- i 1)) i))]
                           [i (if (= i c) (max 0 (- c 1)) i)])
                      (values (string-append (substring in 0 i) (substring in c (string-length in))) i)))))
  (defcmd prompt-kill "Clear the input" (prompt-edit! (lambda (in c) (values "" 0))))
  (defcmd prompt-left "Cursor left" (prompt-edit! (lambda (in c) (values in (string-grapheme-before in c)))))
  (defcmd prompt-right "Cursor right" (prompt-edit! (lambda (in c) (values in (string-grapheme-after in c)))))
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

  (define local-keymap
    (menu 'local "Local"
          "d" 'search "Search" "f" 'search-this "Search This" "r" 'search-repeat "Repeat Search"
          "e" 'search-regex "Search Regex" "n" 'select-all-occurrences "All Occurrences"))

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
          "w" 'toggle-whitespace "Whitespace" "s" 'pick-key-scheme "Key Scheme"))

  ;; ctrl+w, as in Vim and Helix: panes. The directions are Ki's, and the
  ;; arrows.
  (define pane-menu
    (menu 'pane "Pane"
          "v" 'split-right "Split Right" "s" 'split-below "Split Below"
          "q" 'close-pane "Close" "o" 'only-pane "Only This"
          "w" 'next-pane "Next" "W" 'previous-pane "Previous"
          "j" 'pane-left "←" "l" 'pane-right "→" "i" 'pane-up "↑" "k" 'pane-down "↓"
          "left" 'pane-left "←" "right" 'pane-right "→" "up" 'pane-up "↑" "down" 'pane-down "↓"
          "+" 'grow-pane "Grow" "-" 'shrink-pane "Shrink"))

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
          "n" local-keymap "Local" "t" transform-keymap "Transform"
          "f" 'open-file "Files" "b" 'switch-buffer "Buffers"
          ";" 'explore "Explorer" "/" 'help "Help" "space" 'command-palette "Command"
          "e" 'eval-expression "Eval" "v" 'paste-system "Paste System"))

  ;; What every key scheme shares in normal mode: the space menu, panes,
  ;; escape, the pages. The rest is the scheme's (ki.sls, vim.sls,
  ;; helix.sls), normal-keymap's parent.
  (at-load (bind normal-keymap
        "space" space-keymap "Space" "ctrl+w" pane-menu "Pane" "esc" 'escape "Escape"
        "pagedown" 'scroll-down "Scroll ↓" "pageup" 'scroll-up "Scroll ↑"
        "ctrl+z" 'suspend "Suspend" "ctrl+q" 'quit "Quit"))

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
  ;; Starting

  (define quad-version "0.1.0")

  ;; What *scratch* says of the keys in use.
  (define (scratch-keys)
    (let ([s (current-key-scheme)])
      (if (or (not s) (eq? (key-scheme-name s) 'ki))
          (string-append ";; Keys are Ki's: space / lists them, space space runs a command by name,\n"
                         ";; and space e evaluates Scheme. Select a form with d, then space l e.\n"
                         ";; New to them? space k h (or quad --tutor) teaches them; space j s picks\n"
                         ";; Vim's or Helix's instead.\n")
          (format ";; Keys are ~a's: space / lists them, space space runs a command by name,\n;; space e evaluates Scheme, and space j s picks another way to edit.\n"
                  (key-scheme-title s)))))

  ;; The buffers every editor starts with, and the files asked for; the
  ;; first file (or *scratch*) is what new clients show. setup runs before
  ;; the files open (the init file, the working directory's project), so
  ;; that what it sets up applies to them too.
  (define editor-init!
    (case-lambda
     [(files) (editor-init! files void)]
     [(files setup)
      (let ([m (new-buffer! "*Messages*" "" fundamental-mode)])
        (buffer-read-only?-set! m #t)
        (set-messages-buffer! m))
      (setup)
      ;; This process's own command line may name a pipe (quad <(git diff))
      ;; for it to read.
      (let ([opened (parameterize ([open-special-files? #t]) (map open-file! files))])
        (set-current-buffer!
       (if (pair? opened)
           (car opened)
           (new-buffer! "*scratch*"
                        (string-append ";; Welcome to quad " quad-version ", an editor written in Chez Scheme.\n"
                                       (scratch-keys)
                                       "\n(message \"hello from ~a\" (scheme-version))\n")
                        (or (find-major-mode 'scheme) fundamental-mode)))))]))

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
