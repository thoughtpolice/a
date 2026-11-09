;; client.sls -- clients and people, messages, variables, hooks, the buffers
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The bottom of the editor core (see editor.sls): who is attached and as
;; whom, which of them is current, what each was told, the variables and
;; hooks everything else is configured by, and the list of buffers.
(library (quad client)
  (export
          make-connection connection? connection-send connection-close make-client client?
          client-id client-name client-name-set! client-connection client-connection-set!
          client-rows client-rows-set! client-cols client-cols-set! client-capabilities
          client-capabilities-set! client-view client-view-set! client-views client-prompt
          client-prompt-set! client-layer client-layer-set! client-jumps client-jumps-set!
          client-jump-callback client-jump-callback-set! client-message client-message-set!
          client-geometry client-geometry-set! client-pending-clipboard
          client-pending-clipboard-set! client-dirty? client-dirty?-set! client-frame
          client-frame-set! client-locals client-popup client-popup-set! client-has?
          client-local client-local-set! peer-colors person? people client-user
          set-client-user! client-color assign-color! default-user-name clients current-client
          current-view current-buffer set-current-client! with-client with-client-or-any
          client-send! add-client! remove-client! view-of client-switch-buffer! editor-running?
          editor-stop! editor-restart! editor-daemon? editor-daemon?-set! editor-quit!
          client-quit! messages-buffer set-messages-buffer! current-message clear-message!
          log-message! show! message message-error variables define-variable define-variable*
          variable-names variable-doc get-var set-var! local-keys local-key set-local! hooks
          add-hook! remove-hook! run-hooks condition->string buffers add-buffer! remove-buffer!
          background)
  (import (chezscheme) (quad util) (quad text) (quad buffer)
          (only (quad kernel) kernel-hostname))

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
  ;; The buffers, in the order made: what's in them is editor.sls's.

  (define the-buffers '())

  (define (buffers) the-buffers)

  (define (add-buffer! b)
    (set! the-buffers (append the-buffers (list b)))
    (run-hooks 'buffer-created-hook b)
    b)

  (define (remove-buffer! b) (set! the-buffers (remq b the-buffers)))

  ;; Who runs when no client does.
  (define background (add-client! "background" #f 24 80 '())))
