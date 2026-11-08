;; codex.ss -- the agent extension, against a stand-in app server
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; QUAD_TEST_DIR is this directory; QUAD_INIT an init file in an empty
;; directory, where the agent works.

(define here (getenv "QUAD_TEST_DIR"))
(define work (path-dirname (getenv "QUAD_INIT")))

;; Run the event loop until (pred), or fail after ten seconds.
(define (run-until name pred)
  (let* ([deadline (+ (real-time) 10000)]
         [src (make-source -1 void
                           (lambda () (max 0 (- deadline (real-time))))
                           (lambda () (failure!) (printf "FAIL ~a: timed out\n" name) (editor-stop!))
                           (lambda () (when (pred) (editor-stop!))))])
    (add-source! src)
    (unless (pred) (server-run!))
    (remove-source! src)
    (editor-restart!)
    (redraw!)))

(define (on-screen? s) (exists (lambda (r) (string-contains r s)) (screen)))

(headless-start! 30 120)
(set-var! 'codex-command (list (quad-self-path) "-q" "--batch" (path-join here "codex-server.ss")))
(check "not running yet" (not (codex-running?)))
(check "the AI menu" (eq? (keymap-lookup-target (keymap-lookup-target space-keymap "a") "a") 'codex-ask))

;; Ask, from the AI menu.
(press! "space" "a" "a")
;; A dialog in the middle of the screen, not the bottom row.
(check "a dialog" (and (on-screen? "Ask Codex") (on-screen? "Describe a change")))
(check "in the middle" (let loop ([rs (screen)] [i 0])
                         (cond [(null? rs) #f] [(string-contains (car rs) "Ask Codex") (< 3 i 15)]
                               [else (loop (cdr rs) (+ i 1))])))
(type! "add a command")
(press! "enter")
(check "running" (codex-running?))
(check "the popup" (and (on-screen? "Codex · working") (on-screen? "› add a command")))
(check "working, in the status line" (on-screen? "codex ⋯"))

;; The agent asks before running a command: a picker.
(run-until "an approval" (lambda () (current-prompt)))
(check "approval needed" (and (on-screen? "Run make check?") (on-screen? "codex: approve?")))
;; The picker covers the popup; the conversation is as it shows it.
(check "it streamed" (string-contains (codex-transcript-text) "Looking around."))
(check "it showed its tool calls" (string-contains (codex-transcript-text) "λ quad_eval (+ 1 2)"))
(press! "enter")
(run-until "the turn's end" (lambda () (not (codex-busy?))))
(check "done" (and (on-screen? "Done in 1.5s.") (on-screen? "$ make check  ✓")))
(check "no longer working" (not (on-screen? "codex ⋯")))

;; What the stand-in was told, and what quad's tools answered it.
(define results
  (let* ([t (codex-transcript-text)] [i (string-contains t "RESULTS ")])
    (json-read-string (car (string-split (substring t (+ i 8) (string-length t)) #\newline)))))
(define (result . path) (apply json-ref results path))
(check "the question came with context"
       (let ([in (result 'input)])
         (and (string-contains in "add a command") (string-contains in "<quad-context>"))))
(expect-equal "its directory is the init file's" (result 'cwd) work)
(check "its instructions say where" (result 'instructions))
(expect-equal "quad's tools" (result 'tools)
              '#("quad_eval" "quad_describe" "quad_apropos" "quad_keymap" "quad_reload_config" "quad_context"))
(expect-equal "eval" (result 'eval) '((ok . #t) (text . "output:\nhi\nvalue: 3")))
(check "a failed eval" (and (not (result 'fail 'ok)) (string-contains (result 'fail 'text) "car")))
(check "describe" (string-contains (result 'describe 'text) "command escape: Hide the popup"))
(check "keymap" (string-contains (result 'keymap 'text) "a → codex-ask (Ask)"))
(check "no such tool" (not (result 'missing 'ok)))
(check "reloaded" (and (result 'reload 'ok) (string-contains (result 'reload 'text) "Loaded")))
(check "what the agent wrote is in the editor" (command? (find-command 'from-codex)))
(check "context" (string-contains (result 'context 'text) "init file: "))
(expect-equal "the approval" (result 'decision) "accept")

;; The conversation, in a buffer.
(press! "space" "a" "t")
(check "transcript" (and (equal? (buffer-name (current-buffer)) "*codex*")
                         (string-contains (buffer-contents) "› add a command")))

;; Escape hides the popup; space a p brings it back.
(press! "esc")
(check "hidden" (not (on-screen? "Codex")))
(press! "space" "a" "p")
(check "shown" (on-screen? "space a a ask"))

;; Stopping.
(codex-stop!)
(check "stopped" (not (codex-running?)))

;; A server that is not there.
(codex-new-thread!)
(set-var! 'codex-command '("/nonexistent/codex" "app-server"))
(codex-ask! "anything")
(check "a missing server is an error" (and (not (codex-busy?)) (string-contains (codex-transcript-text) "/nonexistent/codex")))
