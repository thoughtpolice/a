;; editor.sls -- the editor core: clients, buffers, commands, keymaps, hooks
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; This is the extension surface, much as Emacs Lisp's is: everything here is
;; visible to init files and to --eval, and the standard commands
;; (commands.sls) are written against it like any user's would be.
;;
;;   (define-command name "doc" thunk)     ; a named, documented command
;;   (define-key keymap "alt+k" 'name)     ; bind a key, or a keymap (a layer)
;;   (define-variable name default "doc")  ; a variable, buffer-local on demand
;;   (add-hook! 'after-save-hook proc)     ; run code when things happen
;;   (define-major-mode! name syntax)      ; a language: syntax, keys, hook
;;
;; The editor is a server, and every user interface is a client of it (see
;; docs/design.md). Buffers, commands, keymaps, hooks, variables and the
;; clipboard history are shared; each client has its own views (one per
;; buffer it has visited, each with its own selections and modes), its own
;; prompt, layer, jump labels and message, and a connection that carries what
;; it should draw. Commands run on behalf of one client, the current client:
;; current-view, current-buffer, message, prompts and so on are its.
(library (quad editor)
  (export
   ;; clients
   make-connection connection? connection-send connection-close
   client? client-id client-name client-rows client-cols client-rows-set! client-cols-set!
   client-capabilities client-has? client-connection client-view client-views
   client-frame client-frame-set! client-dirty? client-dirty?-set! client-local client-local-set!
   client-user set-client-user! client-color person? people default-user-name peer-colors
   clients current-client set-current-client! with-client with-client-or-any add-client! remove-client! client-send!
   client-quit! client-switch-buffer! view-of
   ;; editor state
   current-view current-buffer set-current-buffer! switch-to-buffer! buffers
   editor-running? editor-quit! editor-stop! editor-restart! editor-daemon? editor-daemon?-set!
   find-buffer-named kill-buffer! add-buffer!
   open-file! new-buffer! show-text-buffer! save-buffer! buffer-display-name
   ;; messages
   message message-error current-message clear-message! messages-buffer log-message!
   set-messages-buffer!
   ;; variables
   define-variable get-var set-var! set-local! variable-names variable-doc
   ;; hooks
   add-hook! remove-hook! run-hooks
   ;; commands
   define-command command? command-name command-doc command-proc
   find-command command-names run-command last-command this-command
   ;; keymaps
   make-keymap keymap? keymap-name keymap-title keymap-on-tap keymap-on-tap-set!
   keymap-momentary?-set!
   keymap-momentary? keymap-bindings define-key undefine-key! keymap-lookup
   keymap-lookup-target
   keymap-entries binding-target binding-label
   normal-keymap insert-keymap prompt-keymap global-keymap
   ;; layers, legend and jumps
   active-layer active-layer-keymap layer-legend-visible? exit-layer! enter-layer!
   jump-labels jump-labels-set! jump-callback
   ;; modes
   define-major-mode! find-major-mode major-mode-for-path auto-mode-alist
   auto-mode-alist-set! add-auto-mode! fundamental-mode set-major-mode!
   set-binary-mode! binary-buffer?
   ;; selections
   set-sels! primary set-primary! sels-of selection-mode-of set-selection-mode!
   push-selection-history! selection-history-back! selection-history-forward!
   ;; clipboard
   clipboard-push! clipboard-top clipboard-cycle! clipboard-history primary-selection
   primary-selection-set! system-clipboard-request!
   ;; prompts
   make-prompt prompt? prompt-label prompt-input prompt-input-set! prompt-cursor
   prompt-cursor-set! prompt-items prompt-index prompt-index-set! prompt-style prompt-hint prompt-most
   current-prompt open-prompt! close-prompt! prompt-refresh! prompt-accept!
   read-string-prompt read-string-dialog pick
   ;; popups
   make-popup popup? popup-title popup-lines popup-footer current-popup show-popup! hide-popup!
   ;; geometry, for the mouse
   view-geometry view-geometry-set! screen->position display-column grapheme-after grapheme-before
   ;; events
   handle-event idle-timeout
   ;; batch / eval
   quad-environment quad-libraries eval-string condition->string)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (only (quad kernel) kernel-hostname))

  ;; ---------------------------------------------------------------------------
  ;; Clients
  ;;
  ;; A connection is how the server reaches a client: (send message) and
  ;; (close). The background client has none: it is who --eval, --batch and
  ;; hooks with no client of their own run as.

  (define-record-type connection (fields send close))

  (define-record-type client
    (fields id (mutable name) (mutable connection)
            (mutable rows) (mutable cols) (mutable capabilities)
            (mutable view)            ; the view shown
            views                     ; buffer -> view
            (mutable prompt) (mutable layer) (mutable jumps) (mutable jump-callback)
            (mutable message) (mutable geometry) (mutable pending-clipboard)
            (mutable dirty?) (mutable frame) locals (mutable popup))
    (protocol
     (lambda (new)
       (lambda (id name connection rows cols capabilities)
         (new id name connection rows cols capabilities #f (make-eq-hashtable)
              #f #f '() #f #f #f #f #t #f (make-eq-hashtable) #f)))))

  (define (client-has? c capability) (and (member capability (client-capabilities c)) #t))
  (define (client-local c key default) (hashtable-ref (client-locals c) key default))
  (define (client-local-set! c key v) (hashtable-set! (client-locals c) key v))

  ;; ---------------------------------------------------------------------------
  ;; People: who is at each client, for the others to see

  ;; How many colors people are told apart by (faces ui.peer.N.*).
  (define peer-colors 6)

  ;; Clients that are someone (a terminal, a GUI), not a one-off --eval.
  (define (person? c) (not (equal? (client-name c) "eval")))
  (define (people) (filter person? the-clients))

  ;; Who is at client c: the name it gave, else "client N".
  (define (client-user c) (or (client-local c 'user #f) (format "client ~a" (client-id c))))

  ;; Name client c's person; client-user-hook runs with c and the old
  ;; name (#f the first time).
  (define (set-client-user! c name)
    (let ([old (client-local c 'user #f)])
      (client-local-set! c 'user name)
      (run-hooks 'client-user-hook c old)))

  ;; Client c's color, 0 to peer-colors - 1: the first that nobody else
  ;; here has, given as it attaches.
  (define (client-color c) (client-local c 'color 0))

  (define (assign-color! c)
    (let ([taken (map client-color (remq c the-clients))])
      (client-local-set! c 'color
                         (let loop ([i 0])
                           (cond [(= i peer-colors) (modulo (client-id c) peer-colors)]
                                 [(memv i taken) (loop (+ i 1))]
                                 [else i])))))

  ;; $QUAD_USER, else user@host.
  (define (default-user-name)
    (or (getenv "QUAD_USER")
        (let ([user (or (getenv "USER") "someone")]
              [host (or (getenv "HOSTNAME")
                        (guard (e [#t #f])
                          (let ([h (kernel-hostname)])
                            (and (not (string=? h "")) h))))])
          (if host (format "~a@~a" user (car (string-split host #\.))) user))))

  (define next-client-id 0)
  (define the-clients '())
  (define the-client #f)

  ;; The connected clients, oldest first; the background client is not one.
  (define (clients) the-clients)
  (define (current-client) the-client)

  (define (current-view) (and the-client (client-view the-client)))
  (define (current-buffer) (let ([v (current-view)]) (and v (view-buffer v))))

  ;; Make c the client things run as when no event is being handled: tools
  ;; and tests driving the editor directly use this.
  (define (set-current-client! c)
    (set! the-client c)
    (set-current-edit-view! (client-view c)))

  ;; Run thunk on behalf of client c.
  (define (with-client c thunk)
    (let ([old the-client])
      (dynamic-wind
        (lambda () (set! the-client c) (set-current-edit-view! (client-view c)))
        thunk
        (lambda () (set! the-client old) (set-current-edit-view! (and old (client-view old)))))))

  ;; Run thunk as client c while it is connected, else as any client, else
  ;; as none: for what a client started (a question, a tool's work) that
  ;; may finish after it left.
  (define (with-client-or-any c thunk)
    (let ([c (if (and c (memq c (clients))) c (and (pair? (clients)) (car (clients))))])
      (if c (with-client c thunk) (thunk))))

  ;; Send a message to client c, if it is connected.
  (define (client-send! c msg)
    (let ([conn (client-connection c)])
      (when conn ((connection-send conn) msg))))

  ;; A new client, showing the buffer the current client shows (or the
  ;; first buffer). connection is #f for the background client.
  (define (add-client! name connection rows cols capabilities)
    (set! next-client-id (+ next-client-id 1))
    (let ([c (make-client next-client-id name connection rows cols capabilities)])
      (when connection (set! the-clients (append the-clients (list c))) (assign-color! c))
      (let ([b (or (current-buffer) (and (pair? the-buffers) (car the-buffers)))])
        (when b (client-switch-buffer! c b)))
      (unless the-client (set! the-client c))
      (when connection (run-hooks 'client-attach-hook c))
      c))

  ;; Disconnect client c: its views go, and its connection is closed.
  (define (remove-client! c)
    (when (memq c the-clients)
      (set! the-clients (remq c the-clients))
      (let-values ([(bs vs) (hashtable-entries (client-views c))])
        (vector-for-each detach-view! vs))
      (hashtable-clear! (client-views c))
      (client-view-set! c #f)
      (let ([conn (client-connection c)])
        (client-connection-set! c #f)
        (when conn ((connection-close conn))))
      (run-hooks 'client-detach-hook c)
      (when (eq? the-client c) (set! the-client background))))

  ;; Client c's view of buffer b, made the first time it is asked for.
  (define (view-of c b)
    (or (hashtable-ref (client-views c) b #f)
        (let ([v (make-view b c)])
          (hashtable-set! (client-views c) b v)
          (attach-view! v)
          v)))

  (define (client-switch-buffer! c b)
    (let ([old (client-view c)] [v (view-of c b)])
      (unless (eq? old v)
        (when old (view-last-seen-set! old (real-time)))
        (client-view-set! c v)
        (when (eq? c the-client) (set-current-edit-view! v))
        (with-client c (lambda () (run-hooks 'buffer-switch-hook b))))))

  ;; The editor runs as long as it has clients, or as a daemon until told
  ;; to stop. A client quitting just leaves, unless it is the last.
  (define running? #t)
  (define daemon? #f)
  (define (editor-running?) running?)
  (define (editor-stop!) (set! running? #f))
  (define (editor-restart!) (set! running? #t))
  (define (editor-daemon?) daemon?)
  (define (editor-daemon?-set! x) (set! daemon? x))

  (define (editor-quit!)
    (run-hooks 'kill-editor-hook)
    (for-each (lambda (c) (client-send! c '("bye" "the editor stopped"))) the-clients)
    (set! running? #f))

  (define (client-quit! c)
    (if (or daemon? (exists (lambda (o) (not (eq? o c))) the-clients))
        (begin (client-send! c '("bye" "detached")) (remove-client! c))
        (editor-quit!)))

  ;; ---------------------------------------------------------------------------
  ;; Messages

  (define the-messages-buffer #f)
  (define (messages-buffer) the-messages-buffer)

  (define (set-messages-buffer! b) (set! the-messages-buffer b))
  (define (current-message) (and the-client (client-message the-client)))
  (define (clear-message!) (when the-client (client-message-set! the-client #f)))

  ;; *Messages* keeps every message, appended to its text directly: it has
  ;; no undo history and never counts as modified.
  (define (log-message! s)
    (let ([b the-messages-buffer])
      (when b
        (let ([t (buffer-text b)])
          (text-insert! t (text-length t) (string-append s "\n"))
          (buffer-mark-saved! b)))))

  (define (show! face s)
    (when the-client (client-message-set! the-client (cons face s)))
    (log-message! s))

  (define (message fmt . args) (show! 'ui.message (apply format fmt args)))
  (define (message-error fmt . args) (show! 'ui.message.error (apply format fmt args)))

  ;; ---------------------------------------------------------------------------
  ;; Variables

  (define variables (make-eq-hashtable))  ; name -> (value . doc)

  (define-syntax define-variable
    (syntax-rules ()
      [(_ name default doc)
       (at-load (define-variable* 'name default doc))]))

  (define (define-variable* name default doc)
    (unless (hashtable-contains? variables name)
      (hashtable-set! variables name (cons default doc))))

  (define (variable-names) (vector->list (hashtable-keys variables)))
  (define (variable-doc name) (let ([v (hashtable-ref variables name #f)]) (and v (cdr v))))

  ;; A buffer-local value wins over the global one.
  (define get-var
    (case-lambda
     [(name) (get-var name (current-buffer))]
     [(name b)
      (let ([local (and b (buffer-local b (local-key name) #f))])
        (if local
            (car local)
            (let ([v (hashtable-ref variables name #f)])
              (if v (car v) (errorf 'get-var "no variable named ~s" name)))))]))

  ;; variable-change-hook runs with the name and the new value.
  (define (set-var! name v)
    (let ([old (hashtable-ref variables name #f)])
      (hashtable-set! variables name (cons v (if old (cdr old) "")))
      (run-hooks 'variable-change-hook name v)))

  ;; Buffer-local keys are compared with eq?, so each variable's key is
  ;; interned here.
  (define local-keys (make-eq-hashtable))
  (define (local-key name)
    (or (hashtable-ref local-keys name #f)
        (let ([k (cons 'var name)]) (hashtable-set! local-keys name k) k)))

  (define set-local!
    (case-lambda
     [(name v) (set-local! name v (current-buffer))]
     [(name v b) (buffer-local-set! b (local-key name) (list v))]))

  (define-variable tab-width 8 "Columns a tab character occupies.")
  (define-variable indent-unit "  " "The text one level of indentation inserts.")
  (define-variable auto-pairs #t "Insert closing brackets and quotes in pairs.")
  (define-variable scroll-margin 3 "Lines kept visible above and below the selection.")
  (define-variable legend-delay 300 "Milliseconds before a momentary layer shows its keys.")
  (define-variable line-numbers 'absolute "Gutter line numbers: absolute, relative or #f.")
  (define-variable show-whitespace #f "Draw tabs and trailing spaces.")
  (define-variable trim-trailing-whitespace #f "Remove spaces and tabs at the ends of lines when saving.")
  (define-variable trim-final-newlines #f "Remove newlines after the last one at the end when saving.")
  (define-variable cursorline #t "Highlight the line of the primary selection.")
  (define-variable system-clipboard #t "Copy to the client's system clipboard too.")

  ;; ---------------------------------------------------------------------------
  ;; Hooks

  (define hooks (make-eq-hashtable))

  (define (add-hook! name proc)
    (hashtable-update! hooks name (lambda (l) (if (memq proc l) l (append l (list proc)))) '()))

  (define (remove-hook! name proc)
    (hashtable-update! hooks name (lambda (l) (remq proc l)) '()))

  (define (run-hooks name . args)
    (for-each
     (lambda (p)
       (guard (e [#t (message-error "~a: ~a" name (condition->string e))])
         (apply p args)))
     (hashtable-ref hooks name '())))

  (define (condition->string e)
    (if (condition? e)
        (call-with-string-output-port (lambda (p) (display-condition e p)))
        (format "~s" e)))

  ;; ---------------------------------------------------------------------------
  ;; Commands

  (define-record-type command (fields name doc proc))
  (define commands (make-eq-hashtable))
  (define the-last-command #f)
  (define the-this-command #f)
  (define (last-command) the-last-command)
  (define (this-command) the-this-command)

  (define (define-command name doc proc)
    (hashtable-set! commands name (make-command name doc proc))
    name)

  (define (find-command name) (hashtable-ref commands name #f))
  (define (command-names) (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b)))
                                (vector->list (hashtable-keys commands))))

  ;; Run a command (a name or a procedure). In normal mode each command is
  ;; one undo step; one that enters insert mode extends the step until the
  ;; insert session ends.
  (define (run-command c)
    (let* ([v (current-view)]
           [b (view-buffer v)]
           [proc (cond [(procedure? c) c]
                       [(find-command c) => command-proc]
                       [else (errorf 'run-command "no command named ~s" c)])])
      (set! the-this-command c)
      ;; A command brings the view back to the selection after scrolling
      ;; with the wheel; scrolling commands set free-scroll again.
      (view-local-set! v 'free-scroll #f)
      (let ([normal? (eq? (view-input-mode v) 'normal)])
        (when normal? (buffer-begin-group! b))
        (guard (e [#t (message-error "~a" (condition->string e))])
          (proc))
        (when (and normal? (eq? (current-view) v) (eq? (view-input-mode v) 'normal))
          (buffer-end-group! b)))
      (set! the-last-command c)
      (run-hooks 'post-command-hook c)))

  ;; ---------------------------------------------------------------------------
  ;; Keymaps
  ;;
  ;; A keymap maps key specs to bindings, each a target (a command name, a
  ;; procedure or a keymap) and a short label for the legend. A keymap bound
  ;; as a target is a layer: pressing its key enters it, and the next key is
  ;; looked up there. A momentary layer has an on-tap command: with the kitty
  ;; protocol it is active only while its key is held, and a tap with no other
  ;; key runs on-tap; on a legacy terminal, pressing its key twice does.

  (define-record-type keymap
    (fields name title bindings (mutable on-tap) (mutable momentary?))
    (protocol
     (lambda (new)
       (case-lambda
        [(name) (new name (symbol->string name) (make-hashtable string-hash string=?) #f #f)]
        [(name title) (new name title (make-hashtable string-hash string=?) #f #f)]
        [(name title on-tap)
         (new name title (make-hashtable string-hash string=?) on-tap (and on-tap #t))]))))

  (define-record-type binding (fields target label order))
  (define binding-counter 0)

  (define define-key
    (case-lambda
     [(km key target) (define-key km key target #f)]
     [(km key target label)
      (set! binding-counter (+ binding-counter 1))
      (hashtable-set! (keymap-bindings km) key
                      (make-binding target
                                    (or label
                                        (cond [(keymap? target) (keymap-title target)]
                                              [(symbol? target) (symbol->string target)]
                                              [else "λ"]))
                                    binding-counter))]))

  (define (undefine-key! km key) (hashtable-delete! (keymap-bindings km) key))

  (define (keymap-lookup km key) (hashtable-ref (keymap-bindings km) key #f))

  ;; What a key is bound to, or #f: handy for reaching into layers, as in
  ;; (define-key (keymap-lookup-target space-keymap "l") "d" 'my-command).
  (define (keymap-lookup-target km key)
    (let ([b (keymap-lookup km key)]) (and b (binding-target b))))

  ;; The bindings, as (key . binding), in the order they were defined.
  (define (keymap-entries km)
    (let-values ([(ks vs) (hashtable-entries (keymap-bindings km))])
      (sort (lambda (a b) (< (binding-order (cdr a)) (binding-order (cdr b))))
            (map cons (vector->list ks) (vector->list vs)))))

  (define global-keymap (make-keymap 'global "Global"))
  (define normal-keymap (make-keymap 'normal "Normal"))
  (define insert-keymap (make-keymap 'insert "Insert"))
  (define prompt-keymap (make-keymap 'prompt "Prompt"))

  ;; ---------------------------------------------------------------------------
  ;; Major modes

  (define major-modes (make-eq-hashtable))
  (define the-auto-mode-alist '())
  (define (auto-mode-alist) the-auto-mode-alist)
  (define (auto-mode-alist-set! l) (set! the-auto-mode-alist l))

  ;; Visit files matching any of `patterns` in the mode named mode-name.
  (define (add-auto-mode! patterns mode-name)
    (set! the-auto-mode-alist
          (append the-auto-mode-alist (map (lambda (p) (cons p mode-name)) patterns))))

  (define (define-major-mode! name syntax)
    (let ([m (make-major-mode name syntax (make-keymap name (symbol->string name)) #f)])
      (hashtable-set! major-modes name m)
      m))

  (define (find-major-mode name) (hashtable-ref major-modes name #f))

  ;; A binary mode's buffers show their file, which is not text (an image,
  ;; say): it is not read into them, and they are read-only and never
  ;; saved.
  (define binary-modes (make-eq-hashtable))
  (define (set-binary-mode! name) (hashtable-set! binary-modes name #t))
  (define (binary-mode? mode) (hashtable-ref binary-modes (major-mode-name mode) #f))
  (define (binary-buffer? b) (binary-mode? (buffer-major-mode b)))

  (define fundamental-mode (define-major-mode! 'text plain-syntax))

  ;; auto-mode-alist holds (pattern . mode-name), a pattern being a file
  ;; extension ("ss") or a whole file name ("Makefile").
  (define (major-mode-for-path path)
    (let ([base (path-basename path)] [ext (path-extension path)])
      (or (exists (lambda (p)
                    (and (or (string=? (car p) ext) (string=? (car p) base))
                         (find-major-mode (cdr p))))
                  the-auto-mode-alist)
          fundamental-mode)))

  (define (set-major-mode! b m)
    (buffer-major-mode-set! b m)
    (when (major-mode-hook m) ((major-mode-hook m) b))
    (run-hooks 'major-mode-hook b))

  ;; ---------------------------------------------------------------------------
  ;; Buffers

  (define the-buffers '())

  (define (buffers) the-buffers)

  (define (add-buffer! b)
    (set! the-buffers (append the-buffers (list b)))
    (run-hooks 'buffer-created-hook b)
    b)

  ;; Show buffer b in the current client.
  (define (switch-to-buffer! b)
    (client-switch-buffer! the-client b)
    b)

  (define (set-current-buffer! b) (switch-to-buffer! b))

  (define (find-buffer-named name)
    (find (lambda (b) (string=? (buffer-name b) name)) the-buffers))

  (define (unique-name name)
    (if (not (find-buffer-named name))
        name
        (let loop ([i 2])
          (let ([n (format "~a<~a>" name i)])
            (if (find-buffer-named n) (loop (+ i 1)) n)))))

  (define (new-buffer! name contents mode)
    (let ([b (make-buffer (unique-name name) #f contents mode)])
      (add-buffer! b)
      (set-major-mode! b mode)
      b))

  ;; Show text, read-only, in the buffer named name (made, in the major
  ;; mode named mode, if there is none): a log, a report, a transcript.
  (define (show-text-buffer! name text mode)
    (let ([b (or (find-buffer-named name)
                 (new-buffer! name "" (or (find-major-mode mode) fundamental-mode)))])
      (buffer-read-only?-set! b #f)
      (buffer-replace-all! b text)
      (buffer-read-only?-set! b #t)
      (switch-to-buffer! b)))

  (define (absolute-path p)
    (if (string-prefix? "/" p) p (path-join (current-directory) p)))

  (define (buffer-display-name b)
    (let ([p (buffer-path b)])
      (if p
          (let ([cwd (path-join (current-directory) "")])
            (if (string-prefix? cwd p) (substring p (string-length cwd) (string-length p)) p))
          (buffer-name b))))

  ;; Visit a file, reusing its buffer if it is open; a missing file makes an
  ;; empty buffer that saving creates.
  ;; The buffer visiting path, opened if need be: before-open-file-hook
  ;; runs with the path first (projects load their configuration then),
  ;; find-file-hook with the new buffer after.
  (define (open-file! path)
    (let* ([path (absolute-path (expand-home path))]
           [existing (find (lambda (b) (equal? (buffer-path b) path)) the-buffers)])
      (or existing
          (let* ([_ (run-hooks 'before-open-file-hook path)]
                 [mode (major-mode-for-path path)]
                 [contents (if (and (file-exists? path) (not (binary-mode? mode))) (read-file-string path) "")]
                 [b (make-buffer (unique-name (path-basename path)) path contents mode)])
            (buffer-local-set! b 'mtime (and (file-exists? path) (file-modification-time path)))
            (when (binary-mode? mode) (buffer-read-only?-set! b #t))
            (add-buffer! b)
            (set-major-mode! b mode)
            (run-hooks 'find-file-hook b)
            b))))

  (define save-buffer!
    (case-lambda
     [(b) (save-buffer! b (buffer-path b))]
     [(b path)
      (unless path (errorf 'save-buffer! "buffer ~a has no file" (buffer-name b)))
      (when (binary-buffer? b) (errorf 'save-buffer! "~a is not text, and is not saved" (buffer-name b)))
      (run-hooks 'before-save-hook b)
      (trim-whitespace! b)
      (write-file-string path (buffer-string b))
      (buffer-path-set! b path)
      (buffer-mark-saved! b)
      (buffer-local-set! b 'mtime (file-modification-time path))
      (run-hooks 'after-save-hook b)
      (message "Wrote ~a (~a lines)" (buffer-display-name b) (text-line-count (buffer-text b)))]))

;; What trim-trailing-whitespace and trim-final-newlines ask of a buffer
  ;; being saved, as one undo step.
  (define (trim-whitespace! b)
    (let* ([t (buffer-text b)] [n (text-length t)]
           [lines (if (get-var 'trim-trailing-whitespace b)
                      (let loop ([l (- (text-line-count t) 1)] [acc '()])
                        (if (< l 0)
                            acc
                            (let* ([s (text-line-start t l)] [e (text-line-end t l)]
                                   [k (let back ([i e]) (if (and (> i s) (memv (text-ref t (- i 1)) '(#\space #\tab))) (back (- i 1)) i))])
                              (loop (- l 1) (if (< k e) (cons (list k e "") acc) acc)))))
                      '())]
           [end (if (get-var 'trim-final-newlines b)
                    ;; At most one newline at the end.
                    (let back ([i n]) (if (and (> i 1) (char=? (text-ref t (- i 1)) #\newline) (char=? (text-ref t (- i 2)) #\newline))
                                          (back (- i 1))
                                          i))
                    n)]
           [lines (filter (lambda (c) (< (car c) end)) lines)]
           [changes (if (< end n) (append lines (list (list end n ""))) lines)])
      (unless (null? changes)
        (buffer-begin-group! b)
        (buffer-edit! b changes)
        (buffer-end-group! b))))

  ;; Kill buffer b: every client showing it moves to the buffer it saw most
  ;; recently (a fresh *scratch* if none is left).
  (define (kill-buffer! b)
    (set! the-buffers (remq b the-buffers))
    (run-hooks 'kill-buffer-hook b)
    (when (null? the-buffers)
      (new-buffer! "*scratch*" "" (or (find-major-mode 'scheme) fundamental-mode)))
    (for-each
     (lambda (c)
       (let ([v (hashtable-ref (client-views c) b #f)])
         (when v
           (hashtable-delete! (client-views c) b)
           (detach-view! v)
           (when (eq? (client-view c) v)
             (client-view-set! c #f)
             (let-values ([(bs vs) (hashtable-entries (client-views c))])
               (let ([recent (sort (lambda (x y) (> (view-last-seen x) (view-last-seen y)))
                                   (filter (lambda (v) (memq (view-buffer v) the-buffers)) (vector->list vs)))])
                 (client-switch-buffer! c (if (pair? recent) (view-buffer (car recent)) (car the-buffers)))))))))
     (cons background the-clients)))

  ;; ---------------------------------------------------------------------------
  ;; Selections
  ;;
  ;; These take a view, or a buffer meaning the current client's view of it.

  (define (as-view x)
    (cond [(view? x) x] [(buffer? x) (view-of the-client x)] [else (errorf 'as-view "not a view or buffer: ~s" x)]))

  (define (sels-of x) (view-sels (as-view x)))
  (define (primary) (view-primary (current-view)))
  (define (selection-mode-of x) (find-selection-mode (view-selection-mode (as-view x))))

  ;; Replace the selections, sorted and merged; the primary stays first.
  (define set-sels!
    (case-lambda
     [(sels) (set-sels! (current-view) sels)]
     [(x sels)
      (when (pair? sels)
        (let* ([v (as-view x)]
               [len (buffer-length (view-buffer v))]
               [clampsel (lambda (s)
                           (make-sel (clamp (sel-start s) 0 len) (clamp (sel-end s) 0 len)
                                     (let ([a (sel-anchor s)])
                                       (and a (cons (clamp (car a) 0 len) (clamp (cdr a) 0 len))))))]
               [p (clampsel (car sels))]
               [rest (delete-duplicates*
                      (filter (lambda (s) (not (and (= (sel-start s) (sel-start p)) (= (sel-end s) (sel-end p)))))
                              (map clampsel (cdr sels)))
                      (lambda (a b) (and (= (sel-start a) (sel-start b)) (= (sel-end a) (sel-end b)))))])
          (view-sels-set! v (cons p rest))))]))

  (define (set-primary! s) (set-sels! (list s)))

  (define (set-selection-mode! x name)
    (find-selection-mode name)
    (view-selection-mode-set! (as-view x) name))

  ;; Selection history, for backspace and tab in normal mode.
  (define (push-selection-history! x)
    (let* ([v (as-view x)] [h (view-local v 'sel-history '())])
      (unless (and (pair? h) (equal? (car (car h)) (view-sels v)))
        (view-local-set! v 'sel-history
                         (take (cons (cons (view-sels v) (view-selection-mode v)) h) 200))
        (view-local-set! v 'sel-future '()))))

  (define (history-step! x from to)
    (let* ([v (as-view x)] [h (view-local v from '())])
      (and (pair? h)
           (begin
             (view-local-set! v to (cons (cons (view-sels v) (view-selection-mode v)) (view-local v to '())))
             (view-local-set! v from (cdr h))
             (set-sels! v (car (car h)))
             (view-selection-mode-set! v (cdr (car h)))
             #t))))

  (define (selection-history-back! x) (history-step! x 'sel-history 'sel-future))
  (define (selection-history-forward! x) (history-step! x 'sel-future 'sel-history))

  ;; ---------------------------------------------------------------------------
  ;; The clipboard: a ring of entries, shared by all clients, each a list of
  ;; strings with one per selection, so that copying with several cursors and
  ;; pasting with as many puts each piece back in its place. The newest entry
  ;; also goes to the system clipboard of the client that copied, if it has
  ;; one.

  (define ring '())
  (define ring-index 0)
  (define the-primary-selection "")

  (define (clipboard-history) ring)

  (define (clipboard-push! strs)
    (let ([strs (if (string? strs) (list strs) strs)])
      (set! ring (take (cons strs (remp (lambda (e) (equal? e strs)) ring)) 60))
      (set! ring-index 0)
      (when (and (get-var 'system-clipboard) (client-has? the-client "clipboard"))
        (client-send! the-client (list "clipboard-set" "c" (string-join strs "\n"))))))

  (define (clipboard-top) (if (null? ring) #f (list-ref ring (min ring-index (- (length ring) 1)))))

  ;; Step through the history: +1 to older entries, -1 to newer.
  (define (clipboard-cycle! step)
    (and (pair? ring)
         (begin
           (set! ring-index (modulo (+ ring-index step) (length ring)))
           (list-ref ring ring-index))))

  (define (primary-selection) the-primary-selection)

  ;; The text the mouse last selected, which middle-click pastes; the
  ;; client's primary selection gets it too.
  (define (primary-selection-set! s)
    (set! the-primary-selection s)
    (when (and (get-var 'system-clipboard) (> (string-length s) 0)
               (client-has? the-client "primary-selection"))
      (client-send! the-client (list "clipboard-set" "p" s))))

  ;; Ask the client for its system clipboard, then call (k text).
  (define (system-clipboard-request! k)
    (if (client-has? the-client "clipboard")
        (begin
          (client-pending-clipboard-set! the-client k)
          (client-send! the-client '("clipboard-get" "c"))
          (message "Asked for the clipboard..."))
        (message-error "This client has no clipboard to ask")))

  ;; ---------------------------------------------------------------------------
  ;; Prompts and pickers
  ;;
  ;; A prompt reads a line in the bottom row. Given a candidates procedure
  ;; it is a picker: candidates are (display . value) pairs, fuzzy-filtered
  ;; by the input; style 'picker draws them in a centered floating window.
  ;; Style 'dialog reads text in a centered window instead, as a form's text
  ;; box would: the label is its title, the input wraps and the box grows
  ;; with it, and hint, if any, shows while the input is empty. Style
  ;; 'secret is a dialog that shows bullets for what is typed. A picker's
  ;; hint, if any, is shown above its query: the question it asks. Style
  ;; 'menu shows the candidates in a small window at the cursor, as
  ;; completions; its on-change typically puts the input in the text.

  (define-record-type prompt
    (fields label (mutable input) (mutable cursor) candidates
            (mutable items) (mutable index) on-accept on-change style hint
            (mutable most))             ; the most items it has had, for its size
    (protocol
     (lambda (new)
       (case-lambda
        [(label initial candidates on-accept on-change style)
         (new label initial (string-length initial) candidates '() 0 on-accept on-change style #f 0)]
        [(label initial candidates on-accept on-change style hint)
         (new label initial (string-length initial) candidates '() 0 on-accept on-change style hint 0)]))))

  (define (current-prompt) (and the-client (client-prompt the-client)))

  (define (prompt-refresh! p)
    (when (prompt-candidates p)
      (let* ([input (prompt-input p)]
             [all ((prompt-candidates p) input)]
             [scored (if (string=? input "")
                         (map (lambda (c) (list 0 '() c)) all)
                         (filter-map (lambda (c)
                                       (let ([s (fuzzy-score input (car c))])
                                         (and s (list (car s) (cdr s) c))))
                                     all))]
             [sorted (if (string=? input "") scored (sort (lambda (a b) (> (car a) (car b))) scored))])
        (prompt-items-set! p (map (lambda (x) (cons (caddr x) (cadr x))) sorted))
        (prompt-most-set! p (max (prompt-most p) (length sorted)))
        (prompt-index-set! p (clamp (prompt-index p) 0 (max 0 (- (length sorted) 1))))))
    (when (prompt-on-change p) ((prompt-on-change p) (prompt-input p))))

  (define (open-prompt! p)
    (client-prompt-set! the-client p)
    (prompt-refresh! p))

  (define (close-prompt!) (client-prompt-set! the-client #f))

  (define (prompt-accept! p)
    (close-prompt!)
    (let ([items (prompt-items p)])
      (if (prompt-candidates p)
          (if (pair? items)
              ((prompt-on-accept p) (cdr (car (list-ref items (prompt-index p)))))
              ((prompt-on-accept p) (prompt-input p)))
          ((prompt-on-accept p) (prompt-input p)))))

  (define read-string-prompt
    (case-lambda
     [(label k) (read-string-prompt label "" k)]
     [(label initial k) (open-prompt! (make-prompt label initial #f k #f 'line))]))

  ;; Read text in a centered window titled title, then call (k text). hint
  ;; (a string or #f) says what to write. A secret's text is not shown.
  (define read-string-dialog
    (case-lambda
     [(title hint k) (read-string-dialog title hint "" k)]
     [(title hint initial k) (read-string-dialog title hint initial k #f)]
     [(title hint initial k secret?)
      (open-prompt! (make-prompt title initial #f k #f (if secret? 'secret 'dialog) hint))]))

  ;; Pick among candidates, a list or a procedure from the input to a list,
  ;; of (display . value) pairs, then call (k value).
  (define pick
    (case-lambda
     [(label candidates k) (pick label candidates k 'picker)]
     [(label candidates k style) (pick label candidates k style #f)]
     [(label candidates k style hint)
      (open-prompt! (make-prompt label "" (if (procedure? candidates) candidates (lambda (_) candidates))
                                 k #f style hint))]))

  ;; ---------------------------------------------------------------------------
  ;; Popups
  ;;
  ;; A popup is a floating window of text a client shows over its view, at
  ;; the right, until it is hidden (escape hides it): an agent's progress, a
  ;; command's output. It does not take the keys. (lines) gives its
  ;; contents each time it is drawn, as (text . face) pairs, a face name for
  ;; each line of text; long lines wrap, and the last lines show. footer is a
  ;; hint for its bottom border, or #f. The title and footer may be
  ;; procedures too, called each time it is drawn.

  (define-record-type popup (fields title lines footer))

  (define (current-popup) (and the-client (client-popup the-client)))
  (define (show-popup! p) (client-popup-set! the-client p))
  (define (hide-popup!) (when the-client (client-popup-set! the-client #f)))

  ;; ---------------------------------------------------------------------------
  ;; Layers, legends and jumps, per client

  ;; The active layer: #(keymap trigger-key held? used? entered-at)
  (define (active-layer) (and the-client (client-layer the-client)))
  (define (active-layer-keymap) (let ([l (active-layer)]) (and l (vector-ref l 0))))
  (define (exit-layer!) (client-layer-set! the-client #f))

  ;; A momentary layer is held only when the client reports key releases.
  (define (enter-layer! km key)
    (client-layer-set! the-client
                       (vector km key (and (keymap-momentary? km) (client-has? the-client "release-events"))
                               #f (real-time))))

  ;; A momentary layer shows its legend once its key has been held a moment;
  ;; a menu shows it at once.
  (define (layer-legend-visible?)
    (let ([l (active-layer)])
      (and l
           (or (not (keymap-momentary? (vector-ref l 0)))
               (>= (- (real-time) (vector-ref l 4)) (get-var 'legend-delay))))))

  ;; The milliseconds until client c's screen changes on its own, -1 for
  ;; never: the server's poll timeout.
  (define (idle-timeout c)
    (let ([l (client-layer c)])
      (if (and l (keymap-momentary? (vector-ref l 0))
               (< (- (real-time) (vector-ref l 4)) (get-var 'legend-delay)))
          (max 1 (- (get-var 'legend-delay) (- (real-time) (vector-ref l 4))))
          -1)))

  ;; Jump labels: a list of (label-string . range), and what to do with the
  ;; range picked.
  (define (jump-labels) (if the-client (client-jumps the-client) '()))
  (define (jump-callback) (client-jump-callback the-client))
  (define (jump-labels-set! labels k)
    (client-jumps-set! the-client labels)
    (client-jump-callback-set! the-client k))

  ;; ---------------------------------------------------------------------------
  ;; Geometry: where the client's view is drawn, which the display records
  ;; each frame: (row col height width top left).

  (define (view-geometry) (and the-client (client-geometry the-client)))
  (define (view-geometry-set! g) (client-geometry-set! the-client g))

  ;; The cluster of text t at i (see grapheme-end in (quad util)), up to
  ;; `end`, and the columns it takes at column col: its end and columns.
  (define (cluster t i end col)
    (if (char=? (text-ref t i) #\tab)
        (values (+ i 1) (let ([tw (get-var 'tab-width)]) (- tw (modulo col tw))))
        (let* ([ref (lambda (k) (text-ref t k))] [j (grapheme-end ref i end)])
          (values j (grapheme-columns ref i j)))))

  ;; The position after the grapheme cluster at p, and the start of the
  ;; one before p: where moving and deleting by characters goes.
  (define (grapheme-after b p)
    (let ([t (buffer-text b)])
      (grapheme-end (lambda (i) (text-ref t i)) p (text-length t))))

  (define (grapheme-before b p)
    (if (<= p 0)
        0
        (let ([t (buffer-text b)])
          (grapheme-start (lambda (i) (text-ref t i)) (- p 1)
                          (text-line-start t (text-line-of t (- p 1)))))))

  ;; The display column of pos on its line.
  (define (display-column b pos)
    (let* ([t (buffer-text b)] [s (text-line-start t (text-line-of t pos))])
      (let loop ([i s] [col 0])
        (if (>= i pos)
            col
            (let-values ([(j w) (cluster t i pos col)]) (loop j (+ col w)))))))

  ;; The buffer position under screen cell (row, col), or #f outside the
  ;; text area; columns left of the text (the gutter) map to the line start.
  (define (screen->position row col)
    (let ([g (view-geometry)] [b (current-buffer)])
      (and g b
           (let ([r (- row (list-ref g 0))] [c (- col (list-ref g 1))])
             (and (<= 0 r (- (list-ref g 2) 1))
                  (let* ([t (buffer-text b)]
                         [line (+ r (list-ref g 4))])
                    (if (>= line (text-line-count t))
                        (buffer-length b)
                        (let ([goal (+ (max 0 c) (list-ref g 5))]
                              [s (text-line-start t line)] [e (text-line-end t line)])
                          (let loop ([i s] [col 0])
                            (if (>= i e)
                                e
                                (let-values ([(j w) (cluster t i e col)])
                                  (if (> (+ col w) goal) i (loop j (+ col w))))))))))))))

  ;; ---------------------------------------------------------------------------
  ;; Events, from the current client

  (define (lookup-normal b key)
    (or (keymap-lookup (major-mode-keymap (buffer-major-mode b)) key)
        (keymap-lookup normal-keymap key)
        (keymap-lookup global-keymap key)))

  (define (lookup-insert b key)
    (or (keymap-lookup insert-keymap key)
        (keymap-lookup global-keymap key)))

  (define (run-binding bnd key)
    (let ([t (binding-target bnd)])
      (if (keymap? t)
          (enter-layer! t key)
          (run-command t))))

  (define (handle-jump-key ev)
    (let* ([key (key-event->spec ev)]
           [labels (jump-labels)]
           [matching (filter (lambda (l) (string-prefix? key (car l))) labels)])
      (cond
       [(null? matching) (jump-labels-set! '() #f) (message "Jump cancelled")]
       [(and (= 1 (length matching)) (string=? key (car (car matching))))
        (let ([k (jump-callback)])
          (jump-labels-set! '() #f)
          (run-command (lambda () (k (cdr (car matching))))))]
       [else
        ;; Two-letter labels: keep the ones that start with this key.
        (client-jumps-set! the-client
                           (map (lambda (l) (cons (substring (car l) 1 (string-length (car l))) (cdr l)))
                                matching))])))

  (define (handle-layer-key ev)
    (let* ([layer (active-layer)]
           [km (vector-ref layer 0)]
           [trigger (vector-ref layer 1)]
           [held? (vector-ref layer 2)]
           [key (key-event->spec ev)])
      (cond
       [(eq? (key-event-kind ev) 'release)
        (when (and held? (string=? key trigger))
          (let ([used? (vector-ref layer 3)])
            (exit-layer!)
            (when (and (not used?) (keymap-on-tap km))
              (run-command (keymap-on-tap km)))))]
       [(and held? (string=? key trigger)) (void)] ; key repeat while held
       [(string=? key "esc") (exit-layer!)]
       [(and (not held?) (string=? key trigger) (keymap-on-tap km))
        (exit-layer!)
        (run-command (keymap-on-tap km))]
       [(keymap-lookup km key)
        => (lambda (bnd)
             (let ([t (binding-target bnd)])
               (cond
                [(keymap? t)
                 ;; A nested menu replaces this layer.
                 (enter-layer! t key)]
                [held?
                 ;; While the layer key is held, keep the layer for more.
                 (vector-set! layer 3 #t)
                 (run-command t)]
                [else
                 (exit-layer!)
                 (run-command t)])))]
       [else
        (exit-layer!)
        (message "~a: ~a is not bound" (keymap-title km) key)])))

  (define (self-insert-text ev)
    (let ([text (key-event-text ev)])
      (and text (zero? (logand (key-event-mods ev) (logior mod-ctrl mod-alt mod-super))) text)))

  (define (handle-key ev)
    (let ([v (current-view)] [key (key-event->spec ev)] [p (current-prompt)])
      (cond
       [p
        (when (key-event-press? ev)
          (let ([bnd (keymap-lookup prompt-keymap key)])
            (cond
             [bnd (run-command (binding-target bnd))]
             [(self-insert-text ev)
              => (lambda (s)
                   (let* ([in (prompt-input p)] [c (prompt-cursor p)])
                     (prompt-input-set! p (string-append (substring in 0 c) s (substring in c (string-length in))))
                     (prompt-cursor-set! p (+ c (string-length s)))
                     (prompt-index-set! p 0)
                     (prompt-refresh! p)))])))]
       [(pair? (jump-labels)) (when (key-event-press? ev) (handle-jump-key ev))]
       [(active-layer) (handle-layer-key ev)]
       [(not (key-event-press? ev)) (void)]
       [(eq? (view-input-mode v) 'insert)
        (cond
         [(lookup-insert (view-buffer v) key) => (lambda (bnd) (run-binding bnd key))]
         [(self-insert-text ev) => (lambda (s) (run-command (lambda () (insert-text! s))))]
         [else (message "~a is not bound in insert mode" key)])]
       [else
        (clear-message!)
        (cond
         [(lookup-normal (view-buffer v) key) => (lambda (bnd) (run-binding bnd key))]
         [else (message "~a is not bound" key)])])))

  ;; Typing goes through the insert-text-function variable, which
  ;; commands.sls sets, so that it can be replaced.
  (define-variable insert-text-function #f "Inserts typed text at every cursor.")
  (define (insert-text! s) ((get-var 'insert-text-function) s))

  ;; Handle an event from the current client. Mouse and paste handling are
  ;; hooks: commands.sls installs them.
  (define (handle-event ev)
    (run-hooks 'before-event-hook ev)
    (cond
     [(key-event? ev) (handle-key ev)]
     [(paste-event? ev) (run-hooks 'paste-hook (paste-event-text ev))]
     [(mouse-event? ev) (run-hooks 'mouse-hook ev)]
     [(clipboard-event? ev)
      (let ([k (client-pending-clipboard the-client)])
        (client-pending-clipboard-set! the-client #f)
        (when k (run-command (lambda () (k (clipboard-event-text ev))))))]
     [(focus-event? ev) (run-hooks (if (focus-event-in? ev) 'focus-in-hook 'focus-out-hook))]
     [else (void)]))

  ;; Who runs when no client does.
  (define background (add-client! "background" #f 24 80 '()))

  ;; ---------------------------------------------------------------------------
  ;; Evaluation: init files and --eval run in an environment with the whole
  ;; of quad imported, where top-level definitions are allowed.

  ;; Every quad library loaded -- the core ones, the extensions built in,
  ;; (quad native) from Rust -- with (chezscheme) and (chez rust), for Rust
  ;; objects: what init files see.
  (define (quad-libraries)
    (cons* '(chezscheme) '(chez rust)
           (sort (lambda (a b) (string<? (format "~s" a) (format "~s" b)))
                 (filter (lambda (l) (and (pair? l) (eq? (car l) 'quad))) (library-list)))))

  (define the-environment #f)
  (define (quad-environment)
    (or the-environment
        (begin
          (set! the-environment (copy-environment (apply environment (quad-libraries)) #t))
          the-environment)))

  (define (eval-string s)
    (let ([p (open-input-string s)])
      (let loop ([result (void)])
        (let ([x (read p)])
          (if (eof-object? x) result (loop (eval x (quad-environment)))))))))
