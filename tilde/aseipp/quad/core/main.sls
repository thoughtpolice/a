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
  (export quad-main quad-version editor-init! build-exe!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display) (chez embed) (quad kernel)
          (quad protocol) (quad grid) (quad server) (quad tui) (quad gui) (quad testing)
          ;; Loaded for init files and extensions, which nothing here uses.
          (quad form)
          (quad frontend) (only (quad native) timing-mark gui-prepare gui-display?))

  ;; Sessions over iroh, held while their connections are used: one that
  ;; is collected closes its endpoint.
  (define sessions '())

  (define usage
    "usage: quad [options] [+LINE] [file ...]

  -q, --no-init        don't load the init file, or any project's
  --gui                edit in a window, never the terminal (needs Vulkan
                       and a quad on the host's C library on Linux, Metal 4
                       on macOS); otherwise quad opens a window where there
                       is a display and one can open, and uses the terminal
                       where not
  --tui                edit in the terminal, never a window
  --wait               with a window, stay in the terminal until it closes
                       (for $EDITOR); otherwise the window goes on alone
                       and the command returns once it opens
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
  --test [FILE ...]    run tests of your configuration: the FILEs, or the
                       .ss files in tests/ beside the init file, headless,
                       with the init file loaded (unless -q)
  --tutor              start with the tutor, which teaches the keys
  --repl               a Chez Scheme REPL with all of quad imported
  --build-exe OUT F..  write OUT: this editor, with the Scheme files F...
                       compiled in, as one standalone executable
  --version            print the version
  -h, --help           this message

PATH defaults to $QUAD_SOCKET, or quad.sock in $XDG_RUNTIME_DIR/quad, or
in /tmp/quad-$USER (on Windows, %LOCALAPPDATA%\\quad). The init file is
$QUAD_INIT, or $XDG_CONFIG_HOME/quad/init.ss, or ~/.config/quad/init.ss
(on Windows, %APPDATA%\\quad\\init.ss).
")

  ;; ---------------------------------------------------------------------------
  ;; Setup

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

  ;; Whether a window could be shown here at all: a display to show it on
  ;; (Wayland's or X11's; on macOS, the window server's), unless
  ;; QUAD_NO_DISPLAY=1.
  (define (display-available?) (gui-display?))

  ;; What to edit in, as ui asks -- 'gui, a window (an error where none can
  ;; open); 'tui, this terminal; 'auto, a window where there is a display
  ;; and one opens, else this terminal: (window . why), window #f for the
  ;; terminal, and why the window that was tried did not open.
  (define (open-ui ui)
    (let ([w (guard (e [report-fd (report! "E" (condition->string e)) (exit 1)])
               (case ui
                 [(gui) (cons (gui-window) #f)]
                 [(tui) (cons #f #f)]
                 [else (if (display-available?)
                           (guard (e [#t (cons #f (condition->string e))]) (cons (gui-window) #f))
                           (cons #f #f))]))])
      ;; Detached, the window is this process's to keep; without one, the
      ;; terminal is the parent's (detach!).
      (when report-fd
        (if (car w)
            (report! "W" "")
            (begin (report! "T" (or (cdr w) "")) (exit 0))))
      w))

  ;; ---------------------------------------------------------------------------
  ;; Detaching
  ;;
  ;; A window goes on without the terminal it was started from, which gets
  ;; its prompt back once the window is open (unless --wait, as $EDITOR
  ;; needs). The child is a new quad with the same arguments (kernel.c),
  ;; which gets here too and takes a forked child's part: it tries, and
  ;; says over a pipe how it went -- "W", it opened; "T" and why not, so the
  ;; parent goes on in the terminal; "E" and an error, which the parent
  ;; reports. It is started before the parent knows a window will open,
  ;; and before the parent starts any thread (the device made ahead).

  ;; In the detached child, the pipe to its parent.
  (define report-fd #f)

  (define (report! what text)
    (let ([b (string->utf8 (string-append what text))])
      (kernel-write report-fd b (bytevector-length b))
      (kernel-close report-fd)
      (set! report-fd #f)))

  ;; Whether a window may open, and should go on without the terminal: not
  ;; in an app macOS started, which has no terminal, and whose window is its
  ;; own process's.
  (define (detaches? o)
    (and (not (options-wait? o)) (not (eq? (options-ui o) 'tui)) (display-available?)
         (zero? (kernel-launched-as-app))))

  ;; Forks, if o says to: returns the ui this process goes on with (the
  ;; terminal's, in a parent whose child had no window), or exits (the
  ;; parent, once its child's window is open, or failed).
  (define (detach! o)
    (if (not (detaches? o))
        (options-ui o)
        (let-values ([(pid fd) (kernel-fork-detached)])
          (cond
           [(not pid) (options-ui o)]          ; no fork: stay attached
           [(= pid 0) (set! report-fd fd) (options-ui o)]
           [else
            (let* ([said (read-all fd)] [what (and (> (string-length said) 0) (string-ref said 0))]
                   [text (if what (substring said 1 (string-length said)) "")])
              (kernel-close fd)
              (case what
                [(#\W) (exit 0)]
                [(#\E) (fprintf (current-error-port) "quad: ~a\n" text) (exit 1)]
                [else
                 (set! detach-why (if (eqv? what #\T) text "the window's process stopped"))
                 'tui]))]))))

  ;; Why a parent went on in the terminal, if it did.
  (define detach-why #f)

  ;; Everything on fd until it ends, as text.
  (define (read-all fd)
    (let loop ([acc '()])
      (let ([got (kernel-read-some fd -1)])
        (if got
            (loop (cons got acc))
            (utf8->string (apply bytevector-append (reverse acc)))))))

  ;; Start making what a window draws with, on another thread, where one
  ;; may open, so that it opens sooner: Vulkan's device takes longer to
  ;; make than the editor takes to start.
  (define (prepare-ui! ui)
    (when (and (not (eq? ui 'tui)) (display-available?))
      (gui-prepare)))

  ;; What sets the editor up before its files open: the init file, then
  ;; what extensions do with the directory quad started in (startup-
  ;; directory-hook: the project extension loads its project); with init?
  ;; #f (-q), none of it (skip-configuration-hook).
  (define (configure! init?)
    (lambda ()
      (if init?
          (begin (load-init-file! (init-file-path)) (run-hooks 'startup-directory-hook (working-directory)))
          (run-hooks 'skip-configuration-hook))))

  ;; The editor with this terminal or a window attached (as ui asks, see
  ;; open-ui); with the tutor shown, if tutor? (and the editor has one).
  (define (interactive! files line init? listen tutor? mesh? ui)
    (prepare-ui! ui)
    (editor-init! files (configure! init?))
    (timing-mark "editor ready")
    (when listen (server-listen! listen))
    (when mesh? (listen-over! 'mesh (lambda (fmt . args) (apply message fmt args))))
    (let ([c (guard (e [#t (report-error e) #f])
               (let ([w (open-ui ui)])
                 ;; Why there is no window goes in *Messages*, not in the
                 ;; way: a quad on the toolchain's C library never has one.
                 (let ([why (or (cdr w) detach-why)])
                   (when (and why (not (string=? why "")))
                     (log-message! (string-append "No window, so this terminal: " why))))
                 (if (car w) (gui-attach! (car w)) (tui-attach!))))])
      (cond
       [(not c) 1]                       ; neither a window nor a terminal
       [else
        (when line (with-client c (lambda () (run-command (lambda () (goto-line! line))))))
        ;; The first client, of an editor started here: quad's setup asks
        ;; its questions there, when there is no init file yet.
        (with-client c (lambda () (run-hooks 'interactive-start-hook c)))
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
      (listen-over! 'mesh (lambda (fmt . args)
                            (apply printf (string-append "quad: " fmt "\n") args)
                            (flush-output-port (current-output-port)))))
    (serve!))

  ;; Accept clients over the transport named name too (an extension's),
  ;; telling how they join with (say fmt arg ...).
  (define (listen-over! name say)
    (let ([t (find-transport name)])
      (unless t (errorf 'quad "this quad was built without its ~a extension" name))
      ((transport-listen t) say)))

  ;; A client of the editor on descriptor fd, in a window or this terminal
  ;; (as ui asks, see open-ui). Returns the exit status.
  (define (client! fd files line ui)
    (prepare-ui! ui)
    (guard (e [#t (report-error e) 1])
      (let ([w (open-ui ui)])
        (if (car w) (gui-connect! (car w) fd files line) (tui-connect! fd files line)))))

  ;; A connection to the editor listening at the default socket, or #f.
  (define (local-editor-fd)
    (let ([path (default-socket-path)])
      (and (socket-exists? path)
           (or (socket-dir-safe? path)
               (begin
                 (fprintf (current-error-port) "quad: not connecting to ~a: its directory is not yours alone\n" path)
                 #f))
           (let ([fd (kernel-unix-connect path)])
             (and (>= fd 0) fd)))))

  ;; A descriptor connected to target, and what keeps it open.
  (define (connect-fd target)
    (if (transport-for target)
        (let ([t (transport-for target)])
          (fprintf (current-error-port) "quad: connecting over ~a...\n" (transport-label t))
          (let-values ([(fd session editor) ((transport-connect t) target)])
            (set! sessions (cons session sessions))
            (values fd session)))
        (let ([fd (begin
                    (unless (socket-dir-safe? target)
                      (errorf 'quad "not connecting to ~a: its directory is not yours alone" target))
                    (kernel-unix-connect target))])
          (when (< fd 0) (errorf 'quad "no server is listening at ~a" target))
          (values fd #f))))

  ;; Evaluate expr in the editor at target (a socket path, a join code or a
  ;; ticket), as a client: print the result. Returns the exit status.
  (define (remote-eval! target expr)
    (let-values ([(fd session) (connect-fd target)])
      (let ([send (frame-sender fd)] [reader (make-frame-reader)])
        (send (list "hello" protocol-version "eval" 3 10 '()))
        (send (list "eval" 1 expr))
        (let loop ()
          (let ([got (kernel-read-some fd -1)])
            (if (or (not got) (kernel-stop-requested?))
                (begin (kernel-close fd) 1)
                (let ([result (find (lambda (m) (equal? (car m) "result")) (reader got (bytevector-length got)))])
                  (if result
                      (begin
                        (send '("detach"))
                        (kernel-close fd)
                        (if (caddr result)
                            (begin (display (cadddr result)) (newline) 0)
                            (begin (display (cadddr result) (current-error-port)) (newline (current-error-port)) 1)))
                      (loop)))))))))

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

  ;; What the command line asks for.
  (define-record-type options
    (fields (mutable mode)      ; edit, help, version, batch, test, repl or build-exe
            (mutable mode-args) ; batch: (file); test: (file ...); build-exe: (out file ...)
            (mutable files)     ; to visit, in order
            (mutable line)      ; +LINE's, or #f
            (mutable init?)     ; load the init file and the project's (not -q)
            (mutable ui)        ; auto (a window where one opens), gui or tui
            (mutable new?) (mutable tutor?) (mutable mesh?) (mutable daemon?)
            (mutable wait?)     ; a window keeps the terminal until it closes
            (mutable listen)    ; a socket path, or #f
            (mutable connect)   ; a socket path, join code or ticket, or #f
            (mutable expr))     ; --eval's, or #f
    (protocol (lambda (new) (lambda () (new 'edit '() '() #f #t 'auto #f #f #f #f #f #f #f #f)))))

  ;; The options args ask for, or a string saying what is wrong with them.
  ;; --help, --version, --batch, --test, --repl and --build-exe end the
  ;; options.
  (define (parse-args args)
    (let ([o (make-options)])
      (define (finish) (options-files-set! o (reverse (options-files o))) o)
      (define (mode! mode args) (options-mode-set! o mode) (options-mode-args-set! o args) (finish))
      (let loop ([args args])
        (define (next) (loop (cdr args)))
        ;; --opt=VALUE, or bare --opt: the default socket.
        (define (socket-option opt)
          (let ([a (car args)])
            (cond [(string=? a opt) (default-socket-path)]
                  [(string-prefix? (string-append opt "=") a)
                   (substring a (+ 1 (string-length opt)) (string-length a))]
                  [else #f])))
        (if (null? args)
            (finish)
            (let ([a (car args)] [more (cdr args)])
              (cond
               [(member a '("-h" "--help")) (mode! 'help '())]
               [(string=? a "--version") (mode! 'version '())]
               [(string=? a "--repl") (mode! 'repl '())]
               [(string=? a "--batch") (if (pair? more) (mode! 'batch (list (car more))) "--batch needs a file")]
               [(string=? a "--test") (mode! 'test more)]
               [(string=? a "--build-exe") (if (pair? more) (mode! 'build-exe more) "--build-exe needs an output path")]
               [(string=? a "--eval")
                (if (pair? more)
                    (begin (options-expr-set! o (car more)) (loop (cdr more)))
                    "--eval needs an expression")]
               [(string=? a "--tutor") (options-tutor?-set! o #t) (next)]
               [(string=? a "--gui") (options-ui-set! o 'gui) (next)]
               [(string=? a "--tui") (options-ui-set! o 'tui) (next)]
               [(string=? a "--new") (options-new?-set! o #t) (next)]
               [(string=? a "--wait") (options-wait?-set! o #t) (next)]
               [(string=? a "--mesh") (options-mesh?-set! o #t) (next)]
               [(string=? a "--daemon") (options-daemon?-set! o #t) (next)]
               [(member a '("-q" "--no-init")) (options-init?-set! o #f) (next)]
               [(socket-option "--listen") => (lambda (p) (options-listen-set! o p) (next))]
               [(socket-option "--connect") => (lambda (p) (options-connect-set! o p) (next))]
               [(and (> (string-length a) 1) (char=? (string-ref a 0) #\+)
                     (string->number (substring a 1 (string-length a))))
                => (lambda (n) (options-line-set! o n) (next))]
               [(string-prefix? "-" a) (format "unknown option ~a" a)]
               [else (options-files-set! o (cons a (options-files o))) (next)]))))))

  ;; Does what the options ask; returns the exit status.
  (define (run! o)
    (let ([files (options-files o)] [line (options-line o)] [init? (options-init? o)]
          [ui (options-ui o)] [connect (options-connect o)] [expr (options-expr o)])
      (case (options-mode o)
        [(help) (display usage) 0]
        [(version)
         (let-values ([(major minor patch) (scheme-version-number)])
           (printf "quad ~a (Chez Scheme ~a.~a.~a)\n" quad-version major minor patch))
         0]
        [(batch)
         (unless init? (run-hooks 'skip-configuration-hook))
         (batch! (car (options-mode-args o)))]
        [(test)
         ;; The init file, but not the project of the directory the tests
         ;; run in: what they test is the configuration, wherever they run.
         (test-setup-set! (if init?
                              (lambda () (load-init-file! (init-file-path)))
                              (lambda () (run-hooks 'skip-configuration-hook))))
         (run-tests! (let ([files (options-mode-args o)]) (and (pair? files) files)))]
        [(repl)
         (editor-init! '())
         (interaction-environment (quad-environment))
         (waiter-prompt-string "quad>")
         (new-cafe)
         0]
        [(build-exe)
         (build-exe! (car (options-mode-args o)) (cdr (options-mode-args o)))
         0]
        [else
         (cond
          [(and (eq? ui 'gui) (options-daemon? o))
           (display "quad: --gui is a window, and --daemon an editor without one\n" (current-error-port))
           2]
          [(and expr connect) (remote-eval! connect expr)]
          [expr
           (editor-init! files (configure! init?))
           (let ([v (eval-string expr)])
             (unless (eq? v (void)) (write v) (newline))
             0)]
          [connect (let ([ui (detach! o)])
                     (let-values ([(fd session) (connect-fd connect)])
                       (client! fd files line ui)))]
          [(options-daemon? o)
           (daemon! files init? (or (options-listen o) (default-socket-path)) (options-mesh? o))]
          [else
           ;; An editor listening at the default socket is the one to
           ;; edit in, unless this is to be an editor of its own.
           (let* ([ui (detach! o)]
                  [fd (and (not (or (options-new? o) (options-listen o) (options-mesh? o) (options-tutor? o)))
                           (local-editor-fd))])
             (if fd
                 (client! fd files line ui)
                 (interactive! files line init? (options-listen o) (options-tutor? o) (options-mesh? o) ui)))])])))

  (define (quad-main args)
    (timing-mark "scheme started")
    (let ([o (parse-args args)])
      (if (string? o)
          (begin (fprintf (current-error-port) "quad: ~a\n~a" o usage) 2)
          (run! o))))
)
