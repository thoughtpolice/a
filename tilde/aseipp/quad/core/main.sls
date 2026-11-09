;; main.sls -- startup and the command line
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad runs as an editor in a window, where there is a display and one
;; opens, else in its terminal (--gui and --tui choose) -- or, when an
;; editor already listens at the default socket (a daemon), as a client of
;; that one, as emacsclient would (--new starts another) -- as a
;; daemon that clients connect to (--daemon), or as a client of a running
;; editor (--connect). Each editor can also listen for more clients
;; (--listen), and for clients anywhere over iroh (--mesh), who find it
;; by its join code. Headless clients drive the editor for tests and
;; --batch.
(library (quad main)
  (export quad-main quad-version editor-init! build-exe!
          ;; headless driving, for tests and --batch scripts
          headless-start! headless-client! use-client! headless-buffer!
          press! type! screen screen-row screen-cursor screen-of client-received buffer-contents
          selected primary-text redraw!
          check expect-equal failure!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display) (chez embed) (quad kernel)
          (quad protocol) (quad grid) (quad server) (quad tui) (quad gui) (quad project) (quad mesh)
          (quad relay))

  (define quad-version "0.1.0")

  ;; Sessions over iroh, held while their connections are used: one that
  ;; is collected closes its endpoint.
  (define sessions '())

  (define usage
    "usage: quad [options] [+LINE] [file ...]

  -q, --no-init        don't load the init file, or any project's
  --gui                edit in a window, never the terminal (needs Vulkan,
                       and a quad on the host's C library); otherwise quad
                       opens a window where there is a display and one can
                       open, and uses the terminal where not
  --tui                edit in the terminal, never a window
  --new                start an editor of its own, even where a daemon
                       listens at PATH (quad is otherwise its client)
  --listen[=PATH]      also accept clients on the Unix socket PATH
  --daemon             run without a terminal, for clients; implies --listen
  --mesh               also accept clients over iroh, from anywhere: they
                       join with the code this prints, or its ticket, made
                       up for this run alone
  --connect[=PATH]     be a client of the editor listening at PATH, or
                       reached over iroh with a join code or ticket
  --eval EXPR          evaluate EXPR (in that editor, with --connect), print
                       the result, exit
  --batch FILE         run FILE headless, as a script (tests use this)
  --tutor              start with the tutor, which teaches the keys
  --repl               a Chez Scheme REPL with all of quad imported
  --build-exe OUT F..  write OUT: this editor, with the Scheme files F...
                       compiled in, as one standalone executable
  --version            print the version
  -h, --help           this message

PATH defaults to $QUAD_SOCKET, or quad.sock in $XDG_RUNTIME_DIR/quad. The
init file is $QUAD_INIT, or $XDG_CONFIG_HOME/quad/init.ss, or
~/.config/quad/init.ss.
")

  ;; ---------------------------------------------------------------------------
  ;; Setup

  ;; The buffers every editor starts with, and the files asked for; the
  ;; first file (or *scratch*) is what new clients show. setup runs before
  ;; the files open (the init file, the working directory's project), so
  ;; that what it sets up applies to them too.
  (define editor-init!
    (case-lambda
     [(files) (editor-init! files void)]
     [(files setup) (editor-setup! files setup)]))

  (define (editor-setup! files setup)
    (let ([m (new-buffer! "*Messages*" "" fundamental-mode)])
      (buffer-read-only?-set! m #t)
      (set-messages-buffer! m))
    (setup)
    (let ([opened (map open-file! files)])
      (set-current-buffer!
       (if (pair? opened)
           (car opened)
           (new-buffer! "*scratch*"
                        (string-append ";; Welcome to quad " quad-version ", an editor written in Chez Scheme.\n"
                                       ";; Keys are Ki's: space / lists them, space space runs a command by name,\n"
                                       ";; and space e evaluates Scheme. Select a form with d, then space l e.\n"
                                       ";; New to them? space k h (or quad --tutor) teaches them.\n\n"
                                       "(message \"hello from ~a\" (scheme-version))\n")
                        (or (find-major-mode 'scheme) fundamental-mode))))))

  (define (report-error e)
    (display "quad: " (current-error-port))
    (display (condition->string e) (current-error-port))
    (newline (current-error-port)))

  ;; Run the server until it stops; returns the exit status.
  (define (serve!)
    (guard (e [#t (for-each remove-client! (clients)) (report-error e) 70])
      (server-run!)
      (for-each remove-client! (clients))
      0))

  ;; Whether a window could be shown here at all: a display to show it on.
  (define (display-available?)
    (exists (lambda (v) (let ([s (getenv v)]) (and s (not (string=? s "")))))
            '("WAYLAND_DISPLAY" "DISPLAY")))

  ;; What to edit in, as ui asks -- 'gui, a window (an error where none can
  ;; open); 'tui, this terminal; 'auto, a window where there is a display
  ;; and one opens, else this terminal: (window . why), window #f for the
  ;; terminal, and why the window that was tried did not open.
  (define (open-ui ui)
    (case ui
      [(gui) (cons (gui-window) #f)]
      [(tui) (cons #f #f)]
      [else (if (display-available?)
                (guard (e [#t (cons #f (condition->string e))]) (cons (gui-window) #f))
                (cons #f #f))]))

  ;; The editor with this terminal or a window attached (as ui asks, see
  ;; open-ui); with the tutor shown, if tutor? (and the editor has one).
  (define (configure! init?)
    (lambda ()
      (if init?
          (begin (load-init-file! (init-file-path)) (project-visit! (current-directory)))
          (set-var! 'project-config #f))))

  (define (interactive! files line init? listen tutor? mesh? ui)
    (editor-init! files (configure! init?))
    (when listen (server-listen! listen))
    (when mesh? (mesh-listen! #t (mesh-announcer (lambda (fmt . args) (apply message fmt args)))))
    (let ([c (guard (e [#t (report-error e) #f])
               (let ([w (open-ui ui)])
                 ;; Why there is no window goes in *Messages*, not in the
                 ;; way: a quad on the toolchain's C library never has one.
                 (when (cdr w) (log-message! (string-append "No window, so this terminal: " (cdr w))))
                 (if (car w) (gui-attach! (car w)) (tui-attach!))))])
      (cond
       [(not c) 1]                       ; neither a window nor a terminal
       [else
        (when line (with-client c (lambda () (run-command (lambda () (goto-line! line))))))
        (when tutor?
          (with-client c
            (lambda ()
              (if (find-command 'tutor)
                  (run-command 'tutor)
                  (message-error "This quad was built without its tutor")))))
        (serve!)])))

  ;; The editor with no terminal, for clients to connect to.
  (define (daemon! files init? listen mesh?)
    (editor-daemon?-set! #t)
    (editor-init! files (configure! init?))
    (server-listen! listen)
    (printf "quad: listening at ~a\n" listen)
    (flush-output-port (current-output-port))
    (when mesh?
      (mesh-listen! #t (mesh-announcer (lambda (fmt . args)
                                         (apply printf (string-append "quad: " fmt "\n") args)
                                         (flush-output-port (current-output-port))))))
    (serve!))

  ;; Says how clients join, once the endpoint knows, or what failed.
  (define (mesh-announcer say)
    (let ([said '()])
      (lambda (info)
        (for-each (lambda (key what)
                    (let ([v (cdr (assq key info))])
                      (when (and v (not (member (cons key v) said)))
                        (set! said (cons (cons key v) said))
                        (say what v))))
                  '(code ticket error)
                  '("clients anywhere join with the code: quad --connect=~a"
                    "clients join with the ticket: quad --connect=~a"
                    "iroh: ~a")))))

  ;; A client of the editor on descriptor fd, in a window or this terminal
  ;; (as ui asks, see open-ui). Returns the exit status.
  (define (client! fd files line ui)
    (guard (e [#t (report-error e) 1])
      (let ([w (open-ui ui)])
        (if (car w) (gui-connect! (car w) fd files line) (tui-connect! fd files line)))))

  ;; A connection to the editor listening at the default socket, or #f.
  (define (local-editor-fd)
    (let ([path (default-socket-path)])
      (and (file-exists? path)
           (let ([fd (kernel-unix-connect path)])
             (and (>= fd 0) fd)))))

  ;; Where --connect goes: a socket path, a join code or a ticket; bare,
  ;; the local editor's socket.
  (define (connect-target spec)
    (if (eq? spec 'local) (default-socket-path) spec))

  ;; A descriptor connected to target, and what keeps it open.
  (define (connect-fd target)
    (if (mesh-target? target)
        (begin
          (display "quad: connecting over iroh...\n" (current-error-port))
          (let-values ([(fd session editor) (mesh-connect-fd! target)])
            (set! sessions (cons session sessions))
            (values fd session)))
        (let ([fd (kernel-unix-connect target)])
          (when (< fd 0) (errorf 'quad "no server is listening at ~a" target))
          (values fd #f))))

  ;; Evaluate expr in the editor listening at path, as a client: print the
  ;; result. Returns the exit status.
  (define (remote-eval! target expr)
    (let-values ([(fd session) (connect-fd target)])
      (let ([send (frame-sender fd)] [reader (make-frame-reader)] [buf (make-bytevector 65536)])
        (send (list "hello" protocol-version "eval" 3 10 '()))
        (send (list "eval" 1 expr))
        (let loop ()
          (let ([n (kernel-read fd buf (bytevector-length buf) -1)])
            (if (<= n 0)
                (begin (kernel-close fd) 1)
                (let ([result (find (lambda (m) (equal? (car m) "result")) (reader buf n))])
                  (if result
                      (begin
                        (send '("detach"))
                        (kernel-close fd)
                        (if (caddr result)
                            (begin (display (cadddr result)) (newline) 0)
                            (begin (display (cadddr result) (current-error-port)) (newline (current-error-port)) 1)))
                      (loop)))))))))

  ;; ---------------------------------------------------------------------------
  ;; Headless driving
  ;;
  ;; A batch script connects clients that keep a model of their screen, as
  ;; any client would, presses keys as them, and checks their screens and
  ;; the buffers:
  ;;
  ;;   (headless-start! 24 80 "file.ss")
  ;;   (press! "s" "l" "r" "r")       ; WORD mode, next word, delete it
  ;;   (expect-equal "deleted" (buffer-contents) "...")

  (define models (make-eq-hashtable))   ; client -> grid model
  (define the-test-client #f)

  ;; Connect a headless client of the given size; kitty? says whether it
  ;; reports key releases.
  (define headless-client!
    (case-lambda
     [(rows cols) (headless-client! rows cols #f)]
     [(rows cols kitty?)
      (letrec* ([model (make-grid-model)]
                [paint (lambda (msg) (grid-model-apply! model msg))]
                [c (server-connect! "headless" rows cols
                                    (append (if kitty? '("release-events") '())
                                            '("clipboard" "primary-selection" "scroll"))
                                    (frontend-sender (lambda () c) paint)
                                    void)])
        (frontend! c paint)
        (hashtable-set! models c model)
        (render-client! c)
        c)]))

  ;; Make c the client keys are pressed as, and the current client.
  (define (use-client! c)
    (set! the-test-client c)
    (set-current-client! c))

  (define headless-start!
    (case-lambda
     [(rows cols) (headless-start! rows cols #f)]
     [(rows cols file) (headless-start! rows cols file #f)]
     [(rows cols file kitty?)
      (editor-init! (if file (list file) '()))
      (use-client! (headless-client! rows cols kitty?))]))

  ;; A fresh buffer with `contents` in major mode `mode` (a name), shown,
  ;; with its first character selected in CHAR mode.
  (define (headless-buffer! contents mode)
    (let ([b (new-buffer! "test" contents (or (find-major-mode mode) fundamental-mode))])
      (switch-to-buffer! b)
      (redraw!)
      b))

  ;; The texts of the current view's selections, primary first.
  (define (selected)
    (let ([v (current-view)])
      (map (lambda (s) (buffer-substring (view-buffer v) (sel-range-start s) (sel-range-end s))) (view-sels v))))
  (define (primary-text) (car (selected)))

  (define (redraw!) (server-render!))

  ;; Press keys as the current test client: key specs ("j", "alt+k",
  ;; "space"), events, or lists of them. The server draws after each.
  (define (press! . keys)
    (for-each
     (lambda (k)
       (deliver! the-test-client (event->message (if (string? k) (spec->key-event k) k)))
       (server-render!))
     (let flat ([k keys]) (cond [(null? k) '()] [(pair? k) (append (flat (car k)) (flat (cdr k)))] [else (list k)]))))

  ;; Type a string, a key per character.
  (define (type! s)
    (apply press! (map (lambda (c) (if (char=? c #\space) "space" (if (char=? c #\newline) "enter" (string c))))
                       (string->list s))))

  (define (screen-of c) (grid-model-lines (hashtable-ref models c #f)))
  (define (screen) (screen-of the-test-client))
  (define (screen-row n) (list-ref (screen) n))
  ;; Where the test client's cursor is, (row col shape), or #f.
  (define (screen-cursor) (grid-model-cursor (hashtable-ref models the-test-client #f)))
  ;; The messages a client got that are not about its screen, newest first.
  (define (client-received c) (grid-model-other (hashtable-ref models c #f)))
  (define (buffer-contents) (buffer-string (current-buffer)))

  ;; Macros expanded elsewhere may not reference assigned variables, so the
  ;; failure count is reached through procedures.
  (define failures 0)
  (define (failure!) (set! failures (+ failures 1)))

  ;; (check name expr): passes when expr is true; an error fails it.
  (define-syntax check
    (syntax-rules ()
      [(_ name expr)
       (let ([v (guard (e [#t (list 'error (if (condition? e)
                                               (call-with-string-output-port (lambda (p) (display-condition e p)))
                                               e))])
                  (if expr #t #f))])
         (if (eq? v #t)
             (printf "ok   ~a\n" name)
             (begin (failure!)
                    (printf "FAIL ~a: ~s\n" name v))))]))

  (define (expect-equal name got want)
    (if (equal? got want)
        (printf "ok   ~a\n" name)
        (begin
          (failure!)
          (printf "FAIL ~a\n  got:  ~s\n  want: ~s\n" name got want))))

  (define (batch! file)
    (guard (e [#t (display "quad: " (current-error-port))
                  (if (condition? e) (display-condition e (current-error-port)) (write e (current-error-port)))
                  (newline (current-error-port))
                  1])
      (load file (lambda (x) (eval x (quad-environment))))
      (if (> failures 0)
          (begin (printf "~a failure~a\n" failures (if (= failures 1) "" "s")) 1)
          0)))

  ;; ---------------------------------------------------------------------------
  ;; Standalone executables
  ;;
  ;; quad is a kernel with boot files appended (see (chez embed), from the
  ;; toolchain). --build-exe copies the running executable's kernel and boot
  ;; files, compiles the given Scheme files into one more boot file, and
  ;; appends that: its code runs as the editor boots, with all of quad in
  ;; scope, before any init file.

  (define (read-forms path)
    (call-with-input-file path
      (lambda (p) (let loop ([acc '()]) (let ([x (read p)]) (if (eof-object? x) (reverse acc) (loop (cons x acc))))))))

  (define (build-exe! out files)
    (let* ([self (quad-self-path)]
           [index (read-boot-index self)]
           [tmp (format "~a.build~a" out (random 1000000))]
           [objs '()])
      (when (null? index) (errorf 'build-exe "~a has no boot files appended" self))
      (mkdir tmp)
      ;; Each file is compiled as top-level code that imports all of quad.
      (for-each
       (lambda (f i)
         (let ([src (format "~a/site~a.ss" tmp i)] [obj (format "~a/site~a.so" tmp i)])
           (call-with-output-file src
             (lambda (p)
               (let ([forms (read-forms f)])
                 (write `(import ,@(quad-libraries)) p)
                 (newline p)
                 (for-each (lambda (x) (unless (and (pair? x) (eq? (car x) 'import)) (write x p) (newline p))) forms))))
           (parameterize ([compile-file-message #f] [generate-inspector-information #f])
             (compile-file src obj))
           (set! objs (append objs (list obj)))))
       files (iota (length files)))
      (let ([boot (format "~a/site.boot" tmp)])
        (apply make-boot-file boot '("quad") objs)
        (pack-executable out self (executable-kernel-length self)
                         (append (map (lambda (e) (cons (car e) (extract-boot self (car e)))) index)
                                 (list (cons "site" boot))))
        (for-each delete-file (append (map (lambda (o) (string-append (substring o 0 (- (string-length o) 3)) ".ss")) objs) objs (list boot)))
        (delete-directory tmp)
        (printf "wrote ~a (~a boot files)\n" out (+ 1 (length index))))))

  ;; ---------------------------------------------------------------------------
  ;; The command line

  (define (quad-main args)
    (define tutor? #f)
    (define mesh? #f)
    ;; What to edit in: 'auto (a window where one opens, else the
    ;; terminal), 'gui or 'tui.
    (define ui 'auto)
    (define new? #f)
    (let loop ([args args] [files '()] [line #f] [init? #t] [listen #f] [daemon? #f] [connect #f] [expr #f])
      ;; --opt, or --opt=PATH.
      (define (path-option opt)
        (cond [(string=? (car args) opt) (default-socket-path)]
              [(string-prefix? (string-append opt "=") (car args))
               (substring (car args) (+ 1 (string-length opt)) (string-length (car args)))]
              [else #f]))
      (cond
       [(null? args)
        (let ([files (reverse files)])
          (cond
           [(and expr connect) (remote-eval! (connect-target connect) expr)]
           [expr
            (editor-init! files (configure! init?))
            (let ([v (eval-string expr)])
              (unless (eq? v (void)) (write v) (newline))
              0)]
           [(and (eq? ui 'gui) daemon?)
            (display "quad: --gui is a window, and --daemon an editor without one\n" (current-error-port))
            2]
           [connect (let-values ([(fd session) (connect-fd (connect-target connect))])
                      (client! fd files line ui))]
           [daemon? (daemon! files init? (or listen (default-socket-path)) mesh?)]
           [else
            ;; An editor listening at the default socket is the one to
            ;; edit in, unless this is to be an editor of its own.
            (let ([fd (and (not (or new? listen mesh? tutor?)) (local-editor-fd))])
              (if fd
                  (client! fd files line ui)
                  (interactive! files line init? listen tutor? mesh? ui)))]))]
       [(member (car args) '("-h" "--help")) (display usage) 0]
       [(string=? (car args) "--version")
        (let-values ([(major minor patch) (scheme-version-number)])
          (printf "quad ~a (Chez Scheme ~a.~a.~a)\n" quad-version major minor patch))
        0]
       [(string=? (car args) "--tutor") (set! tutor? #t) (loop (cdr args) files line init? listen daemon? connect expr)]
       [(string=? (car args) "--gui") (set! ui 'gui) (loop (cdr args) files line init? listen daemon? connect expr)]
       [(string=? (car args) "--tui") (set! ui 'tui) (loop (cdr args) files line init? listen daemon? connect expr)]
       [(string=? (car args) "--new") (set! new? #t) (loop (cdr args) files line init? listen daemon? connect expr)]
       [(member (car args) '("-q" "--no-init")) (loop (cdr args) files line #f listen daemon? connect expr)]
       [(path-option "--listen") => (lambda (p) (loop (cdr args) files line init? p daemon? connect expr))]
       [(string=? (car args) "--daemon") (loop (cdr args) files line init? listen #t connect expr)]
       [(string=? (car args) "--connect") (loop (cdr args) files line init? listen daemon? 'local expr)]
       [(path-option "--connect") => (lambda (p) (loop (cdr args) files line init? listen daemon? p expr))]
       [(string=? (car args) "--mesh") (set! mesh? #t) (loop (cdr args) files line init? listen daemon? connect expr)]
       [(and (string=? (car args) "--eval") (pair? (cdr args)))
        (loop (cddr args) files line init? listen daemon? connect (cadr args))]
       [(and (string=? (car args) "--batch") (pair? (cdr args)))
        (unless init? (set-var! 'project-config #f))
        (batch! (cadr args))]
       [(string=? (car args) "--repl")
        (editor-init! '())
        (interaction-environment (quad-environment))
        (waiter-prompt-string "quad>")
        (new-cafe)
        0]
       [(and (string=? (car args) "--build-exe") (pair? (cdr args)))
        (build-exe! (cadr args) (cddr args))
        0]
       [(and (> (string-length (car args)) 1) (char=? (string-ref (car args) 0) #\+)
             (string->number (substring (car args) 1 (string-length (car args)))))
        => (lambda (n) (loop (cdr args) files n init? listen daemon? connect expr))]
       [(string-prefix? "-" (car args))
        (fprintf (current-error-port) "quad: unknown option ~a\n~a" (car args) usage)
        2]
       [else (loop (cdr args) (cons (car args) files) line init? listen daemon? connect expr)]))))
