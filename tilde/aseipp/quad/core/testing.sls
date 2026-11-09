;; testing.sls -- driving the editor headless: tests and --batch scripts
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A batch script (quad --batch FILE, which batch! runs) connects clients
;; that keep a model of their screen, as any client would, presses keys as
;; them, and checks their screens and the buffers:
;;
;;   (headless-start! 24 80 "file.ss")
;;   (press! "s" "l" "r" "r")       ; WORD mode, next word, delete it
;;   (expect-equal "deleted" (buffer-contents) "...")
;;
;; Tests of a configuration run so too, with quad --test (run-tests!):
;; there the editor is set up with the init file loaded, and each file's
;; checks are counted.
(library (quad testing)
  (export batch! run-tests! test-setup-set!
          headless-start! headless-client! use-client! headless-buffer!
          press! type! screen screen-row screen-cursor screen-of client-received buffer-contents
          selected primary-text redraw!
          check expect-equal failure!
          run-until on-screen? screen-row-of prompt-titled? error-message-of
          test-temp-dir write-file! model-client! headless-gpu)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor)
          (quad commands) (quad display) (quad protocol) (quad grid) (quad server) (quad frontend)
          (only (quad native) gui-headless))

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
                [c (frontend-connect! "headless" rows cols
                                      (append (if kitty? '("release-events") '())
                                              '("clipboard" "primary-selection" "scroll"))
                                      paint void)])
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
      ;; Under quad --test the editor is set up once, for every file.
      (if (messages-buffer)
          (when file (switch-to-buffer! (open-file! file)))
          (editor-init! (if file (list file) '()) test-setup))
      (use-client! (headless-client! rows cols kitty?))]))

  ;; What sets the editor up as headless-start! starts it: nothing, for
  ;; --batch; the init file, for --test (main.sls).
  (define test-setup void)
  (define (test-setup-set! thunk) (set! test-setup thunk))

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
  (define passes 0)
  (define (failure!) (set! failures (+ failures 1)))
  (define (pass!) (set! passes (+ passes 1)))

  ;; (check name expr): passes when expr is true; an error fails it.
  (define-syntax check
    (syntax-rules ()
      [(_ name expr)
       (let ([v (guard (e [#t (list 'error (if (condition? e)
                                               (call-with-string-output-port (lambda (p) (display-condition e p)))
                                               e))])
                  (if expr #t #f))])
         (if (eq? v #t)
             (begin (pass!) (printf "ok   ~a\n" name))
             (begin (failure!)
                    (printf "FAIL ~a: ~s\n" name v))))]))

  (define (expect-equal name got want)
    (if (equal? got want)
        (begin (pass!) (printf "ok   ~a\n" name))
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

  ;; Run the tests in files (#f: the .ss files in tests/ beside the init
  ;; file), one after another, in one editor set up as test-setup says; an
  ;; error ends a file, as a failure, and the next runs. Returns the exit
  ;; status: 1 if anything failed.
  (define (run-tests! files)
    (let ([files (or files (default-test-files))])
      (if (null? files)
          (begin
            (printf "no tests: write some in ~a\n" (or (test-directory) "tests/ beside the init file"))
            0)
          (begin
            (for-each
             (lambda (file)
               (printf "~a\n" file)
               (guard (e [#t (failure!)
                             (printf "FAIL ~a: ~a\n" file
                                     (if (condition? e)
                                         (call-with-string-output-port (lambda (p) (display-condition e p)))
                                         e))])
                 (load file (lambda (x) (eval x (quad-environment))))))
             files)
            (remove-test-dirs!)
            (printf "~a passed, ~a failed, in ~a file~a\n" passes failures (length files)
                    (if (= (length files) 1) "" "s"))
            (if (> failures 0) 1 0)))))

  ;; tests/ beside the init file, if there is an init file.
  (define (test-directory)
    (let ([init (init-file-path)])
      (and init (path-join (path-dirname init) "tests"))))

  (define (default-test-files)
    (let ([dir (test-directory)])
      (if (and dir (file-directory? dir))
          (map (lambda (f) (path-join dir f))
               (sort-strings (filter (lambda (f) (string-suffix? ".ss" f)) (directory-list dir))))
          '()))))
