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
;;
;; (quad editor) is all of it, from libraries in layers, each built on the
;; ones before it:
;;
;;   client.sls   clients and people, messages, variables, hooks, the
;;                buffer list
;;   keymap.sls   commands and keymaps
;;   prompt.sls   prompts and pickers, popups, layers and jump labels,
;;                where a view is drawn
;;   editor.sls   (this) major modes, buffers and files, selections, the
;;                clipboard, events, evaluation
;;
;; Their shared state is reached through procedures -- (current-client),
;; (clients), (buffers) -- as Chez Scheme exports no variable a library
;; assigns.
(library (quad editor)
  (export
   ;; clients
   make-connection connection? connection-send connection-close
   client? client-id client-name client-rows client-cols client-rows-set! client-cols-set!
   client-capabilities client-has? client-connection client-view client-views
   client-frame client-frame-set! client-local client-local-set! client-route client-divert! client-diverted?
   client-user set-client-user! client-color person? people default-user-name peer-colors
   clients current-client set-current-client! with-client with-client-or-any with-client-if-here
   add-client! remove-client! client-send!
   client-quit! client-switch-buffer! view-of
   ;; panes
   pane? pane-rect pane-rect-set! split? split-dir split-ratio split-ratio-set! split-first split-second
   client-focused-pane client-layout client-panes pane-view-of focus-pane! for-each-pane
   split-pane! close-pane! pane-at
   make-component component? component-name component-draw component-key show-component!
   focused-component pane-component
   ;; editor state
   current-view current-buffer set-current-buffer! switch-to-buffer! buffers
   editor-running? editor-quit! editor-stop! editor-restart! editor-daemon? editor-daemon?-set!
   find-buffer-named kill-buffer! add-buffer!
   span buffer-render! rendered-buffer! data-at-point
   open-file! new-buffer! show-text-buffer! save-buffer! buffer-display-name
   ;; messages
   message message-error current-message clear-message! messages-buffer log-message!
   open-special-files?
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
   keymap-lookup-target keymap-parent keymap-parent-set!
   key-scheme? key-scheme-name key-scheme-title key-scheme-doc key-scheme-keymap
   define-key-scheme! use-key-scheme! find-key-scheme key-scheme-names current-key-scheme
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
   current-prompt open-prompt! close-prompt! prompt-refresh! prompt-edit! prompt-accept!
   prompt-on-select-set! prompt-on-cancel-set! prompt-selected! cancel-prompt!
   read-string-prompt read-string-dialog pick unfiltered unfiltered?
   ;; overlays
   make-overlay overlay? overlay-name overlay-place overlay-widget overlay-key
   make-area area? area-rows area-cols area-top area-bottom area-cursor
   client-overlays show-overlay! hide-overlay! key-overlay
   ;; popups
   make-popup popup? popup-title popup-lines popup-footer current-popup show-popup! hide-popup!
   ;; geometry, for the mouse
   view-geometry view-geometry-set! screen->position display-column grapheme-after grapheme-before
   ;; events
   handle-event idle-timeout
   ;; batch / eval
   quad-environment quad-libraries eval-string condition->string)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (only (quad kernel) kernel-hostname)
          (quad client) (quad keymap) (quad prompt))

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
    (let ([unit (syntax-indent-unit (major-mode-syntax m))])
      (when unit (set-local! 'indent-unit unit b)))
    (when (major-mode-hook m) ((major-mode-hook m) b))
    (run-hooks 'major-mode-hook b))

  ;; ---------------------------------------------------------------------------
  ;; Buffers


  ;; Show buffer b in the current client.
  (define (switch-to-buffer! b)
    (client-switch-buffer! (current-client) b)
    b)

  (define (set-current-buffer! b) (switch-to-buffer! b))

  (define (find-buffer-named name)
    (find (lambda (b) (string=? (buffer-name b) name)) (buffers)))

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
      (buffer-set-text! b text)
      (buffer-read-only?-set! b #t)
      (switch-to-buffer! b)))

  (define (buffer-display-name b)
    (let ([p (buffer-path b)])
      (if p
          (let ([cwd (path-join (working-directory) "")])
            (if (string-prefix? cwd p) (substring p (string-length cwd) (string-length p)) p))
          (buffer-name b))))

  ;; Whether open-file! reads files that are neither regular nor
  ;; directories: pipes, FIFOs, devices. Only this process's own command
  ;; line opens them (main.sls): reading one may block until a writer comes
  ;; (a FIFO) or never end (/dev/zero), which in a daemon would stop every
  ;; client's editor; and a path such as /dev/fd/63 that another process
  ;; sends names a descriptor of its own, not this one's.
  (define open-special-files? (make-parameter #f))

  (define (special-file? path)
    (and (file-exists? path) (not (file-regular? path)) (not (file-directory? path))))

  ;; Visit a file, reusing its buffer if it is open; a missing file makes an
  ;; empty buffer that saving creates.
  ;; The buffer visiting path, opened if need be: before-open-file-hook
  ;; runs with the path first (projects load their configuration then),
  ;; find-file-hook with the new buffer after.
  (define (open-file! path)
    (let* ([path (absolute-path (expand-home path))]
           [existing (find (lambda (b) (equal? (buffer-path b) path)) (buffers))])
      (when (and (not existing) (special-file? path) (not (open-special-files?)))
        (errorf 'open-file "~a is not a regular file: only a quad of its own opens it (quad --new ~a)"
                path path))
      (or existing
          (let* ([_ (run-hooks 'before-open-file-hook path)]
                 [mode (major-mode-for-path path)]
                 [contents (if (and (file-exists? path) (not (binary-mode? mode))) (read-text-file path) "")]
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
                            (let* ([e (text-line-end t l)] [k (blanks-before t e (text-line-start t l))])
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
    (remove-buffer! b)
    (run-hooks 'kill-buffer-hook b)
    (when (null? (buffers))
      (new-buffer! "*scratch*" "" (or (find-major-mode 'scheme) fundamental-mode)))
    (for-each
     (lambda (c)
       ;; In every pane of c's.
       (for-each-pane
        c
        (lambda ()
          (let ([v (hashtable-ref (client-views c) b #f)])
            (when v
              (hashtable-delete! (client-views c) b)
              (detach-view! v)
              (when (eq? (client-view c) v)
                (client-view-set! c #f)
                (let-values ([(bs vs) (hashtable-entries (client-views c))])
                  (let ([recent (sort (lambda (x y) (> (view-last-seen x) (view-last-seen y)))
                                      (filter (lambda (v) (memq (view-buffer v) (buffers))) (vector->list vs)))])
                    (client-switch-buffer! c (if (pair? recent) (view-buffer (car recent)) (car (buffers))))))))))))
     (cons background (clients))))

  ;; ---------------------------------------------------------------------------
  ;; Rendered buffers
  ;;
  ;; An extension shows what it has -- a list, a report, a tree -- as a
  ;; buffer's text with regions over it (buffer.sls): faces to draw it in,
  ;; keys that act on the thing under the cursor, the thing itself as data.
  ;; It describes the content as pieces, each a string, a list of pieces,
  ;; or (span props piece ...): pieces that the one region with properties
  ;; props covers, an alist, as for buffer-add-region!.
  ;;
  ;;   (buffer-render! b
  ;;     (span '((face . ui.text.focus)) "Files\n")
  ;;     (map (lambda (f)
  ;;            (span `((item . #t) (data . ,f) (keymap . ,file-keys)) f "\n"))
  ;;          files))
  ;;
  ;; Rendering again (the list changed) keeps each view's cursor on the
  ;; item it was on, by its data (equal?), else on the item where it was.

  (define-record-type span-piece (fields props pieces))
  (define (span props . pieces) (make-span-piece props pieces))

  ;; The text of pieces, and their regions: (start end props) each.
  (define (flatten-pieces pieces)
    (let-values ([(out get) (open-string-output-port)])
      (let ([regions '()] [pos 0])
        (let walk ([p pieces])
          (cond
           [(string? p) (put-string out p) (set! pos (+ pos (string-length p)))]
           [(null? p) (void)]
           [(pair? p) (walk (car p)) (walk (cdr p))]
           [(span-piece? p)
            (let ([start pos])
              (walk (span-piece-pieces p))
              (set! regions (cons (list start pos (span-piece-props p)) regions)))]
           [else (walk (format "~a" p))]))
        (values (get) regions))))

  (define (buffer-render! b . pieces)
    (let-values ([(text regions) (flatten-pieces pieces)])
      (let ([marks (map (lambda (v)
                          (let* ([t (buffer-text b)] [p (sel-range-start (view-primary v))] [line (text-line-of t p)])
                            (list v (region-property b p 'data) line (- p (text-line-start t line)))))
                        (buffer-views b))])
        (buffer-clear-regions! b)
        (buffer-set-text! b text)
        (buffer-set-regions! b regions)
        (for-each
         (lambda (m)
           (let* ([v (car m)] [data (cadr m)] [t (buffer-text b)]
                  [item (and data (find (lambda (r) (and (region-get r 'item) (equal? (region-get r 'data) data)))
                                        (buffer-regions b)))])
             (view-sels-set! v (list (let* ([p (text-pos-at t (min (caddr m) (- (text-line-count t) 1)) (cadddr m))]
                                            ;; Its item gone: the one where it was.
                                            [item (or item (find (lambda (r) (region-get r 'item)) (regions-at b p)))])
                                       (if item
                                           (make-sel (region-start item) (region-end item))
                                           (make-sel p p)))))))
         marks))))

  ;; The buffer named name, made read-only in the major mode named mode if
  ;; there is none: for an extension to render into.
  (define (rendered-buffer! name mode)
    (or (find-buffer-named name)
        (let ([b (new-buffer! name "" (or (find-major-mode mode) fundamental-mode))])
          (buffer-read-only?-set! b #t)
          b)))

  ;; What the innermost region at the cursor stands for (its data), or #f.
  (define (data-at-point)
    (region-property (current-buffer) (sel-range-start (primary)) 'data))

  ;; ---------------------------------------------------------------------------
  ;; Selections
  ;;
  ;; These take a view, or a buffer meaning the current client's view of it.

  (define (as-view x)
    (cond [(view? x) x] [(buffer? x) (view-of (current-client) x)] [else (errorf 'as-view "not a view or buffer: ~s" x)]))

  (define (sels-of x) (view-sels (as-view x)))
  (define (primary) (view-primary (current-view)))
  (define (selection-mode-of x) (find-selection-mode (view-selection-mode (as-view x))))

  ;; Replace the selections, kept in the text, each once; the primary
  ;; stays first.
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
               [p (clampsel (car sels))])
          (if (null? (cdr sels))
              (view-sels-set! v (list p))
              ;; Ranges by a number each: start and end are at most len.
              (let* ([seen (make-eqv-hashtable)]
                     ;; Whether s's range was not seen yet (and now is).
                     [new? (lambda (s)
                             (let ([key (+ (* (sel-start s) (+ len 1)) (sel-end s))])
                               (and (not (hashtable-contains? seen key))
                                    (begin (hashtable-set! seen key #t) #t))))])
                (new? p)
                (view-sels-set! v (cons p (filter new? (map clampsel (cdr sels)))))))))]))

  (define (set-primary! s) (set-sels! (list s)))

  (define (set-selection-mode! x name)
    (find-selection-mode name)
    (view-selection-mode-set! (as-view x) name))

  ;; Whether selections a and b are the same: records are equal? only
  ;; when they are one.
  (define (same-sels? a b)
    (and (= (length a) (length b))
         (for-all (lambda (x y)
                    (and (= (sel-start x) (sel-start y)) (= (sel-end x) (sel-end y))
                         (equal? (sel-anchor x) (sel-anchor y))))
                  a b)))

  ;; Selection history, for backspace and tab in normal mode.
  (define (push-selection-history! x)
    (let* ([v (as-view x)] [h (view-local v 'sel-history '())])
      (unless (and (pair? h) (same-sels? (car (car h)) (view-sels v)))
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
      (when (and (get-var 'system-clipboard) (client-has? (current-client) "clipboard"))
        (client-send! (current-client) (list "clipboard-set" "c" (string-join strs "\n"))))))

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
               (client-has? (current-client) "primary-selection"))
      (client-send! (current-client) (list "clipboard-set" "p" s))))

  ;; Ask the client for its system clipboard, then call (k text).
  (define (system-clipboard-request! k)
    (if (client-has? (current-client) "clipboard")
        (begin
          (client-pending-clipboard-set! (current-client) k)
          (client-send! (current-client) '("clipboard-get" "c"))
          (message "Asked for the clipboard..."))
        (message-error "This client has no clipboard to ask")))

  ;; ---------------------------------------------------------------------------
  ;; Events, from the current client

  ;; A key in normal mode: the keymaps of the regions at the cursor
  ;; (innermost first), the major mode's, then normal mode's.
  (define (lookup-normal b key)
    (or (let ([v (current-view)])
          (and v (eq? (view-buffer v) b) (pair? (buffer-regions b))
               (exists (lambda (r)
                         (let ([km (region-get r 'keymap)]) (and km (keymap-lookup km key))))
                       (regions-at b (sel-range-start (view-primary v))))))
        (keymap-lookup (major-mode-keymap (buffer-major-mode b)) key)
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
        (client-jumps-set! (current-client)
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
                   (prompt-edit! (lambda (in c) (values (string-splice in c c s) (+ c (string-length s))))))])))]
       ;; An extension's overlay, over the panes, that takes the key.
       [(and (key-event-press? ev) (key-overlay (current-client))
             ((overlay-key (key-overlay (current-client))) key (self-insert-text ev)))
        (void)]
       [(pair? (jump-labels)) (when (key-event-press? ev) (handle-jump-key ev))]
       [(active-layer) (handle-layer-key ev)]
       [(not (key-event-press? ev)) (void)]
       ;; A component's pane: the keys it takes, then the global keymap's,
       ;; and normal mode's space and pane (ctrl+w) layers, which do not
       ;; edit (others, such as deleting's, would edit the view behind it).
       [(focused-component (current-client))
        => (lambda (comp)
             (unless ((component-key comp) key (self-insert-text ev))
               (let ([bnd (or (keymap-lookup global-keymap key)
                              (let ([b (keymap-lookup normal-keymap key)])
                                (and b (keymap? (binding-target b))
                                     (memq (keymap-name (binding-target b)) '(space pane))
                                     b)))])
                 (if bnd (run-binding bnd key) (message "~a is not bound here" key)))))]
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
      (let ([k (client-pending-clipboard (current-client))])
        (client-pending-clipboard-set! (current-client) #f)
        (when k (run-command (lambda () (k (clipboard-event-text ev))))))]
     [(focus-event? ev) (run-hooks (if (focus-event-in? ev) 'focus-in-hook 'focus-out-hook))]
     [else (void)]))


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
