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
          check expect-equal failure!
          run-until on-screen? screen-row-of prompt-titled? error-message-of
          test-temp-dir write-file! model-client! headless-gpu)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display) (chez embed) (quad kernel)
          (quad protocol) (quad grid) (quad server) (quad tui) (quad gui) (quad project) (quad mesh)
          (quad relay) (only (quad native) timing-mark gui-prepare gui-headless gui-display?))

  (define quad-version "0.1.0")

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
  --tutor              start with the tutor, which teaches the keys
  --repl               a Chez Scheme REPL with all of quad imported
  --build-exe OUT F..  write OUT: this editor, with the Scheme files F...
                       compiled in, as one standalone executable
  --version            print the version
  -h, --help           this message

PATH defaults to $QUAD_SOCKET, or quad.sock in $XDG_RUNTIME_DIR/quad, or
in /tmp/quad-$USER. The init file is $QUAD_INIT, or
$XDG_CONFIG_HOME/quad/init.ss, or ~/.config/quad/init.ss.
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
     [(files setup)
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
                        (or (find-major-mode 'scheme) fundamental-mode)))))]))

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
  ;; needs). It must fork before anything starts a thread (the window's,
  ;; the device made ahead of it), so it forks before it knows a window will
  ;; open: the child tries, and says over a pipe how it went -- "W", it
  ;; opened; "T" and why not, so the parent goes on in the terminal; "E" and
  ;; an error, which the parent reports. On macOS the child is a new quad
  ;; with the same arguments instead (kernel.c), which gets here too and
  ;; takes the forked child's part.

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

  ;; What sets the editor up before its files open: the init file and the
  ;; working directory's project, unless init? is #f (-q).
  (define (configure! init?)
    (lambda ()
      (if init?
          (begin (load-init-file! (init-file-path)) (project-visit! (current-directory)))
          (set-var! 'project-config #f))))

  ;; The editor with this terminal or a window attached (as ui asks, see
  ;; open-ui); with the tutor shown, if tutor? (and the editor has one).
  (define (interactive! files line init? listen tutor? mesh? ui)
    (prepare-ui! ui)
    (editor-init! files (configure! init?))
    (timing-mark "editor ready")
    (when listen (server-listen! listen))
    (when mesh? (mesh-listen! #t (mesh-announcer (lambda (fmt . args) (apply message fmt args)))))
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
    (prepare-ui! ui)
    (guard (e [#t (report-error e) 1])
      (let ([w (open-ui ui)])
        (if (car w) (gui-connect! (car w) fd files line) (tui-connect! fd files line)))))

  ;; A connection to the editor listening at the default socket, or #f.
  (define (local-editor-fd)
    (let ([path (default-socket-path)])
      (and (file-exists? path)
           (let ([fd (kernel-unix-connect path)])
             (and (>= fd 0) fd)))))

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

  ;; Evaluate expr in the editor at target (a socket path, a join code or a
  ;; ticket), as a client: print the result. Returns the exit status.
  (define (remote-eval! target expr)
    (let-values ([(fd session) (connect-fd target)])
      (let ([send (frame-sender fd)] [reader (make-frame-reader)])
        (send (list "hello" protocol-version "eval" 3 10 '()))
        (send (list "eval" 1 expr))
        (let loop ()
          (let ([got (kernel-read-some fd -1)])
            (if (not got)
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

  ;; Run the editor's loop until (pred) holds, then draw: for a test that
  ;; waits on a process, a socket or a timer. Ten seconds without it end
  ;; the test, failed: what it would do next might go elsewhere (save a
  ;; buffer, say).
  (define (run-until name pred)
    (let* ([deadline (+ (real-time) 10000)] [timed-out? #f]
           ;; The frame just drawn may be what pred waits for: then the
           ;; loop does not wait, for something that may never come.
           [src (make-source -1 void (lambda () (if (pred) 0 (max 0 (- deadline (real-time)))))
                             (lambda ()
                               (unless (pred) (set! timed-out? #t))
                               (editor-stop!))
                             (lambda () (when (pred) (editor-stop!))))])
      (add-source! src)
      (unless (pred) (server-run!))
      (remove-source! src)
      (when timed-out?
        (printf "FAIL ~a: timed out\n" name)
        (remove-test-dirs!)
        (exit 1))
      (editor-restart!)
      (redraw!)))

  ;; Whether text s is on the test client's screen.
  (define (on-screen? s) (exists (lambda (r) (string-contains r s)) (screen)))

  ;; The first row of client c's screen (the test client's) with s in it,
  ;; or #f.
  (define screen-row-of
    (case-lambda
     [(s) (screen-row-of the-test-client s)]
     [(c s) (let loop ([rs (screen-of c)] [i 0])
              (cond [(null? rs) #f] [(string-contains (car rs) s) i] [else (loop (cdr rs) (+ i 1))]))]))

  ;; Whether a prompt titled title is open.
  (define (prompt-titled? title)
    (let ([p (current-prompt)]) (and p (equal? (prompt-label p) title))))

  ;; The message of what (thunk) raises, or "no error".
  (define (error-message-of thunk)
    (guard (e [#t (if (condition? e) (condition-message e) e)]) (thunk) "no error"))

  ;; A fresh directory for a test, under $TMPDIR, removed when it ends.
  (define test-dirs '())
  (define (test-temp-dir name)
    (let* ([t (current-time)]
           [dir (format "~a/quad-~a-~a-~a" (or (getenv "TMPDIR") "/tmp") name
                        (time-second t) (time-nanosecond t))])
      (mkdir dir)
      (set! test-dirs (cons dir test-dirs))
      dir))

  (define (remove-tree! path)
    (if (and (file-directory? path) (not (file-symbolic-link? path)))
        (begin
          (for-each (lambda (f) (remove-tree! (path-join path f))) (directory-list path))
          (delete-directory path))
        (delete-file path)))

  (define (remove-test-dirs!)
    (for-each (lambda (d) (when (file-exists? d) (remove-tree! d))) test-dirs)
    (set! test-dirs '()))

  ;; Write text to path, making the directories it is in.
  (define (write-file! path text)
    (let mkdir-p ([d (path-dirname path)])
      (unless (file-exists? d) (mkdir-p (path-dirname d)) (mkdir d)))
    (call-with-output-file path (lambda (p) (display text p)) 'replace))

  ;; A client named name, rows by cols, with these capabilities, that keeps
  ;; a model of its screen, as a window or a terminal does: the client and
  ;; its model.
  (define (model-client! name rows cols capabilities)
    (let* ([model (make-grid-model)]
           [c (server-connect! name rows cols capabilities (lambda (m) (grid-model-apply! model m)) void)])
      (values c model)))

  ;; Frames drawn with no window (gui-headless), or the test skipped where
  ;; nothing can draw them.
  (define (headless-gpu family points system-fonts?)
    (guard (e [#t (printf "SKIP: ~a\n" (if (condition? e) (condition->string e) e))
                  (exit 0)])
      (gui-headless family points system-fonts?)))

  (define (batch! file)
    (guard (e [#t (display "quad: " (current-error-port))
                  (if (condition? e) (display-condition e (current-error-port)) (write e (current-error-port)))
                  (newline (current-error-port))
                  (remove-test-dirs!)
                  1])
      (load file (lambda (x) (eval x (quad-environment))))
      (remove-test-dirs!)
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

  ;; What the command line asks for.
  (define-record-type options
    (fields (mutable mode)      ; edit, help, version, batch, repl or build-exe
            (mutable mode-args) ; batch: (file); build-exe: (out file ...)
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
  ;; --help, --version, --batch, --repl and --build-exe end the options.
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
         (unless init? (set-var! 'project-config #f))
         (batch! (car (options-mode-args o)))]
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
