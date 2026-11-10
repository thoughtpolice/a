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
          client-capabilities-set! client-view client-view-set! client-views client-views-set!
          client-prompt
          client-prompt-set! client-layer client-layer-set! client-jumps client-jumps-set!
          client-jump-callback client-jump-callback-set! client-message client-message-set!
          client-geometry client-geometry-set! client-pending-clipboard
          client-pending-clipboard-set! client-frame
          client-frame-set! client-locals client-popup client-popup-set! client-has?
          client-local client-local-set! client-route client-divert! client-diverted?
          peer-colors person? people client-user
          set-client-user! client-color assign-color! default-user-name clients current-client
          current-view current-buffer set-current-client! with-client with-client-or-any
          with-client-if-here
          client-send! add-client! remove-client! view-of client-switch-buffer! editor-running?
          editor-stop! editor-restart! editor-daemon? editor-daemon?-set! editor-quit!
          client-quit! messages-buffer set-messages-buffer! current-message clear-message!
          log-message! show! message message-error variables define-variable define-variable*
          variable-names variable-doc get-var set-var! local-keys local-key set-local! hooks
          add-hook! remove-hook! run-hooks buffers add-buffer! remove-buffer!
          background
          pane? pane-rect pane-rect-set! split? split-dir split-ratio split-ratio-set! split-first
          split-second client-focused-pane client-layout client-panes pane-view-of focus-pane!
          for-each-pane split-pane! close-pane! pane-at
          make-component component? component-name component-draw component-key
          pane-component pane-component-set! show-component! focused-component)
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
            (mutable view)            ; the view shown (the focused pane's)
            (mutable views)           ; buffer -> view (the focused pane's)
            (mutable prompt) (mutable layer) (mutable jumps) (mutable jump-callback)
            (mutable message) (mutable geometry) (mutable pending-clipboard)
            (mutable frame) locals (mutable popup))
    (protocol
     (lambda (new)
       (lambda (id name connection rows cols capabilities)
         (new id name connection rows cols capabilities #f (make-eq-hashtable)
              #f #f '() #f #f #f #f #f (make-eq-hashtable) #f)))))

  (define (client-has? c capability) (and (member capability (client-capabilities c)) #t))
  (define (client-local c key default) (hashtable-ref (client-locals c) key default))
  (define (client-local-set! c key v) (hashtable-set! (client-locals c) key v))

  ;; Divert client c: (route msg) takes its input, and what this editor
  ;; sends it is not drawn. #f undoes it.
  (define (client-route c) (client-local c 'route #f))
  (define (client-divert! c route) (client-local-set! c 'route route))
  (define (client-diverted? c) (and (client-route c) #t))

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
        (let ([user (or (user-name) "someone")]
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

  ;; (thunk) as client c, if it is still connected.
  (define (with-client-if-here c thunk) (when (memq c (clients)) (with-client c thunk)))

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
      (for-each-pane c
                     (lambda ()
                       (let-values ([(bs vs) (hashtable-entries (client-views c))])
                         (vector-for-each detach-view! vs))
                       (hashtable-clear! (client-views c))
                       (client-view-set! c #f)))
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

  ;; ---------------------------------------------------------------------------
  ;; Panes
  ;;
  ;; A client shows its views in panes, side by side or one above another:
  ;; its layout, a tree of splits with a pane at each leaf, the whole of
  ;; the screen between the buffer line and the bottom row. Each pane has
  ;; views of its own (one per buffer it has shown, as a client had before
  ;; it had panes) and a status line. The focused pane's view, views and
  ;; geometry are the client's own -- client-view, client-views,
  ;; client-geometry -- so that what works with the client's view works
  ;; with the focused pane's; another pane keeps its own while unfocused.

  (define-record-type pane
    (fields (mutable view) (mutable views) (mutable geometry)
            (mutable rect)              ; (row col rows cols), as last drawn
            (mutable component)))       ; what it shows instead of its view, or #f

  ;; A component is what a pane shows that is not a buffer's text: it
  ;; draws itself, (draw canvas focused?) -> its cursor, (row col shape)
  ;; on the canvas, or #f (display.sls makes the canvas, a grid the pane's
  ;; size); and takes the keys it wants while its pane is focused, (key
  ;; spec text) -> whether it took it, text what the key types or #f. What it does not take goes to the global
  ;; keymap and to normal mode's space and pane (ctrl+w) layers, but no
  ;; command acts on the view behind it.
  (define-record-type component (fields name draw key))

  ;; dir: 'right, the second beside the first; 'below, under it. ratio:
  ;; the first's share of the space.
  (define-record-type split (fields dir (mutable ratio) (mutable first) (mutable second)))

  (define (client-focused-pane c)
    (or (client-local c 'pane #f)
        (let ([p (make-pane #f #f #f #f #f)])
          (client-local-set! c 'pane p)
          (client-local-set! c 'layout p)
          p)))

  (define (client-layout c) (client-focused-pane c) (client-local c 'layout #f))

  ;; c's panes, in order: left to right, top to bottom.
  (define (client-panes c)
    (let leaves ([n (client-layout c)])
      (if (split? n) (append (leaves (split-first n)) (leaves (split-second n))) (list n))))

  ;; The view pane p of client c shows.
  (define (pane-view-of c p) (if (eq? p (client-focused-pane c)) (client-view c) (pane-view p)))

  (define (focus-pane! c p)
    (let ([old (client-focused-pane c)])
      (unless (eq? old p)
        (pane-view-set! old (client-view c))
        (pane-views-set! old (client-views c))
        (pane-geometry-set! old (client-geometry c))
        (client-view-set! c (pane-view p))
        (client-views-set! c (pane-views p))
        (client-geometry-set! c (pane-geometry p))
        (client-local-set! c 'pane p)
        (when (eq? c the-client) (set-current-edit-view! (client-view c))))))

  ;; Run thunk with each of c's panes focused in turn, the focus as it was
  ;; after (or the first pane's, if that one went).
  (define (for-each-pane c thunk)
    (let ([focused (client-focused-pane c)])
      (for-each (lambda (p) (focus-pane! c p) (thunk)) (client-panes c))
      (focus-pane! c (if (memq focused (client-panes c)) focused (car (client-panes c))))))

  ;; Put node new where old is in c's layout.
  (define (replace-node! c old new)
    (let ([root (client-layout c)])
      (if (eq? root old)
          (client-local-set! c 'layout new)
          (let walk ([n root])
            (when (split? n)
              (cond
               [(eq? (split-first n) old) (split-first-set! n new)]
               [(eq? (split-second n) old) (split-second-set! n new)]
               [else (walk (split-first n)) (walk (split-second n))]))))))

  ;; Split client c's focused pane: a new one, dir ('right or 'below) of
  ;; it, showing its buffer as it does, focused. Returns the new pane.
  (define (split-pane! c dir)
    (let* ([old (client-focused-pane c)] [v (client-view c)]
           [new (make-pane #f (make-eq-hashtable) #f #f #f)])
      (replace-node! c old (make-split dir 1/2 old new))
      (focus-pane! c new)
      (when v
        (client-switch-buffer! c (view-buffer v))
        (let ([nv (client-view c)])
          (view-sels-set! nv (view-sels v))
          (view-top-set! nv (view-top v))
          (view-left-set! nv (view-left v))
          (view-selection-mode-set! nv (view-selection-mode v))))
      new))

  ;; Show component comp in a new pane dir ('right or 'below) of client
  ;; c's focused one, focused. Returns the pane.
  (define (show-component! c comp dir)
    (let ([p (split-pane! c dir)])
      (pane-component-set! p comp)
      p))

  ;; The component client c's focused pane shows, or #f.
  (define (focused-component c) (pane-component (client-focused-pane c)))

  ;; The parent split of node in c's layout, or #f.
  (define (parent-of c node)
    (let walk ([n (client-layout c)])
      (and (split? n)
           (if (or (eq? (split-first n) node) (eq? (split-second n) node))
               n
               (or (walk (split-first n)) (walk (split-second n)))))))

  (define (first-pane node) (if (split? node) (first-pane (split-first node)) node))

  ;; Close client c's focused pane, unless it is the only one: its views
  ;; go, and the pane beside it takes its space, focused. Whether it closed.
  (define (close-pane! c)
    (let* ([p (client-focused-pane c)] [parent (parent-of c p)])
      (and parent
           (let ([sibling (if (eq? (split-first parent) p) (split-second parent) (split-first parent))])
             (let-values ([(bs vs) (hashtable-entries (client-views c))])
               (vector-for-each detach-view! vs))
             (replace-node! c parent sibling)
             ;; Nothing of the closed pane's is kept: focus moves without
             ;; saving it.
             (let ([next (first-pane sibling)])
               (client-local-set! c 'pane next)
               (client-view-set! c (pane-view next))
               (client-views-set! c (pane-views next))
               (client-geometry-set! c (pane-geometry next))
               (when (eq? c the-client) (set-current-edit-view! (client-view c))))
             #t))))

  ;; The pane of c's whose last drawn place has (row, col), or #f.
  (define (pane-at c row col)
    (find (lambda (p)
            (let ([r (pane-rect p)])
              (and r (<= (car r) row (+ (car r) (caddr r) -1)) (<= (cadr r) col (+ (cadr r) (cadddr r) -1)))))
          (client-panes c)))

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
