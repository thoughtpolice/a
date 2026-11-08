;; codex.ss -- the agent extension, against a stand-in app server
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; QUAD_TEST_DIR is this directory; QUAD_INIT an init file in an empty
;; directory, where the agent works.

(define here (getenv "QUAD_TEST_DIR"))
(define work (path-dirname (getenv "QUAD_INIT")))

;; Run the event loop until (pred), or fail after ten seconds. A timeout
;; ends the test: the keys after it would go elsewhere (and might, say,
;; save a buffer).
(define (run-until name pred)
  (let* ([deadline (+ (real-time) 10000)]
         [timed-out? #f]
         [src (make-source -1 void
                           (lambda () (max 0 (- deadline (real-time))))
                           (lambda () (set! timed-out? #t) (editor-stop!))
                           (lambda () (when (pred) (editor-stop!))))])
    (add-source! src)
    (unless (pred) (server-run!))
    (remove-source! src)
    (when timed-out?
      (printf "FAIL ~a: timed out\n" name)
      (exit 1))
    (editor-restart!)
    (redraw!)))

(define (on-screen? s) (exists (lambda (r) (string-contains r s)) (screen)))
;; Wait until the agent asks with a prompt titled title.
(define (asked title)
  (run-until title (lambda () (let ([p (current-prompt)]) (and p (equal? (prompt-label p) title))))))

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
(check "approval needed" (and (on-screen? "Run make check?") (on-screen? "codex: waiting for you")))
(check "the whole command, and why" (and (on-screen? "$ make check") (on-screen? "to test")))
;; The picker covers the popup; the conversation is as it shows it.
(check "it streamed" (string-contains (codex-transcript-text) "Looking around."))
(check "it showed its tool calls" (string-contains (codex-transcript-text) "λ quad_eval (+ 1 2)"))
;; Escape leaves it waiting; space a y takes it up again.
(press! "esc")
(check "still waiting" (and (not (current-prompt)) (= (length (codex-waiting)) 1)))
(press! "space" "a" "y")
(check "asked again" (on-screen? "Run make check?"))
(press! "enter")

;; The agent's questions: a picker of its options, then a secret.
(asked "Color")
(check "the question" (and (on-screen? "Which color do you prefer?") (on-screen? "Blue — Choose blue.")
                           (on-screen? "Something else…")))
(type! "blue")
(press! "enter")
(asked "Token")
(type! "s3cret")
(check "a secret is not shown" (and (on-screen? "••••••") (not (on-screen? "s3cret"))))
(press! "enter")

;; An MCP server's form: a field at a time.
(asked "tracker asks")
(check "its message" (on-screen? "File an issue"))
(press! "enter")
(asked "Title")
(press! "enter")
(check "a required field" (and (equal? (prompt-label (current-prompt)) "Title") (on-screen? "Title is required")))
(type! "Crash")
(press! "enter")
(asked "severity")
(type! "high")
(press! "enter")
(asked "Count")
(type! "x")
(press! "enter")
(check "a number is wanted" (and (equal? (prompt-label (current-prompt)) "Count") (on-screen? "whole number")))
(type! "3")
(press! "enter")
(asked "urgent")
(press! "enter")
(asked "tags")
(type! "b")
(press! "enter")
(check "chosen" (on-screen? "[x] b"))
(press! "enter")
(asked "note")
(check "optional" (on-screen? "Anything else"))
(press! "enter")

;; A link, and more permissions.
(asked "tracker: open a link")
(check "the link" (on-screen? "https://example.com/login"))
(type! "copy")
(press! "enter")
(asked "Give Codex more permissions?")
(check "which" (and (on-screen? "network access") (on-screen? "to fetch a package")))
(type! "session")
(press! "enter")

(run-until "the turn's end" (lambda () (not (codex-busy?))))
(check "nothing waits" (and (null? (codex-waiting)) (not (current-prompt))))
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
(check "questions are on" (result 'questions-on))
(expect-equal "the answers" (result 'question)
              '((answers . ((color . ((answers . #("Blue")))) (token . ((answers . #("s3cret"))))))))
(expect-equal "the form" (result 'form)
              '((action . "accept")
                (content . ((title . "Crash") (severity . "hi") (count . 3) (urgent . #f) (tags . #("b"))))
                (_meta . null)))
(expect-equal "the link" (result 'link) '((action . "accept") (content . null) (_meta . null)))
(expect-equal "copied" (clipboard-top) '("https://example.com/login"))
(expect-equal "the permissions" (result 'permissions)
              '((permissions . ((network . ((enabled . #t))))) (scope . "session")))
;; (The stand-in's RESULTS have it; quad's own lines do not.)
(check "the secret stays out of the transcript"
       (let ([t (codex-transcript-text)])
         (and (string-contains t "→ Blue") (string-contains t "→ (secret)") (not (string-contains t "→ s3cret")))))

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
