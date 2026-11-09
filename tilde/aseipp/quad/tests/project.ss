;; project.ss -- projects: trust, configuration, review, servers of their own
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; QUAD_TEST_DIR is this directory; QUAD_PROJECT_DIR an empty directory, to
;; hold a project, one nested in it, and the trust file.

(define here (getenv "QUAD_TEST_DIR"))
(define dir (getenv "QUAD_PROJECT_DIR"))
(define root (path-join dir "repo"))
(define inner (path-join root "sub"))

(define (run-until name pred)
  (let* ([deadline (+ (real-time) 10000)] [timed-out? #f]
         [src (make-source -1 void (lambda () (max 0 (- deadline (real-time))))
                           (lambda () (set! timed-out? #t) (editor-stop!))
                           (lambda () (when (pred) (editor-stop!))))])
    (add-source! src)
    (unless (pred) (server-run!))
    (remove-source! src)
    (when timed-out? (printf "FAIL ~a: timed out\n" name) (exit 1))
    (editor-restart!)
    (redraw!)))
(define (on-screen? s) (exists (lambda (r) (string-contains r s)) (screen)))
(define (asked? title) (let ([p (current-prompt)]) (and p (equal? (prompt-label p) title))))
(define (choose! text) (type! text) (press! "enter"))

(define (mkdir-p d) (unless (file-exists? d) (mkdir-p (path-dirname d)) (mkdir d)))
(define (write-file! path text) (mkdir-p (path-dirname path)) (call-with-output-file path (lambda (p) (display text p)) 'replace))

(write-file! (path-join root ".quad/init.ss")
             "(project-set! 'tab-width 3)
(project-set! 'trim-trailing-whitespace #t)
(project-set! 'trim-final-newlines #t)
(define-command 'from-project \"A project's command\" (lambda () (message \"from the project\")))
(project-buffer-hook! (lambda (b) (buffer-local-set! b 'seen-by-project #t)))
(project-add-hook! 'after-save-hook (lambda (b) (set-var! 'scroll-margin 7)))
(lsp-servers-from-json (project-path \"servers.json\") 'root (project-root))
")
(write-file! (path-join root "servers.json")
             (format "{\"fake\": {\"command\": ~s, \"args\": [\"-q\", \"--batch\", ~s],
  \"extensionToLanguage\": {\".fake\": \"fakelang\"}, \"initializationOptions\": {\"x\": 1}}}"
                     (quad-self-path) (path-join here "lsp-server.ss")))
(write-file! (path-join root ".quad/files") "# the servers it runs\nservers.json\n../escape\n")
(write-file! (path-join root "a.txt") "one  \ntwo\n")
(write-file! (path-join root "deep/b.fake") "bad\n")
(write-file! (path-join inner ".quad/init.ss") "(project-set! 'tab-width 5)\n")
(write-file! (path-join inner "c.txt") "three\n")
(write-file! (path-join dir "outside.txt") "four\n")

(set-var! 'project-config #t)
(set-var! 'project-trust-file (path-join dir "trusted"))
(set-var! 'codex-command (list (quad-self-path) "-q" "--batch" (path-join here "codex-server.ss")))
;; A server for every .txt file, project or not.
(define-lsp-server! 'plain (list (quad-self-path) "-q" "--batch" (path-join here "lsp-server.ss")) '("txt")
  'roots '(".nothing"))
(headless-start! 30 110)

;; Opening a file in a project asks first, and runs nothing.
(define a (open-file! (path-join root "a.txt")))
(switch-to-buffer! a)
(redraw!)
(check "asked" (and (asked? "Trust this project?") (on-screen? "Have an AI review its code first")
                    (string-contains (prompt-hint (current-prompt)) "lines: .quad/files, .quad/init.ss, servers.json, ../escape). quad would run its code")))
(check "not loaded yet" (and (not (find-command 'from-project)) (= (get-var 'tab-width a) 8)))
(check "no server while it asks" (not (lsp-buffer-server a)))
(choose! "Not now")
(check "declined" (and (not (current-prompt)) (eq? (project-state root) 'declined) (not (find-command 'from-project))))
(check "then the usual servers" (and (lsp-buffer-server a) (equal? (lsp-server-name (lsp-buffer-server a)) "plain")))

;; Asked again, it can be reviewed: Codex reads it as a sample, with no
;; tools, outside the project.
(press! "space" "space")
(choose! "project-trust")
(check "asked again" (asked? "Trust this project?"))
(choose! "review")
(run-until "the review" (lambda () (and (project-review root) (current-prompt))))
(let ([r (project-review root)])
  (check "a verdict" (string-prefix? "VERDICT: CAUTION" r))
  (check "after a harmless turn" (and (string-contains r "after turn review-turn")
                                      (string-contains r "warm-up: Reply with the single word: ready.")))
  (check "no tools, no approvals, read-only" (string-contains r "tools: none; approvals: never; sandbox: read-only"))
  (check "not ephemeral, so it can be sampled" (string-contains r "ephemeral: #f"))
  (check "outside the project" (string-contains r "in the project: #f"))
  (check "the code, fenced by a nonce" (and (string-contains r "fenced: #t") (string-contains r "has the code: #t"))))
(check "the verdict, in the question" (and (asked? "Trust this project?") (on-screen? "CAUTION")
                                           (on-screen? "Read the review")))
(choose! "Read the review")
(check "the review, in a buffer" (and (equal? (buffer-name (current-buffer)) "*project review*")
                                      (string-contains (buffer-contents) "it runs make")))
(switch-to-buffer! a)

;; Trusted, it loads: its variables, hooks and command, for its files only.
(press! "space" "space")
(choose! "project-trust")
(choose! "Trust it")
(check "loaded" (and (eq? (project-state root) 'loaded) (find-command 'from-project)))
(check "its variable" (= (get-var 'tab-width a) 3))
(check "its buffer hook" (buffer-local a 'seen-by-project #f))
(check "the trust is kept" (string-contains (read-file-string (path-join dir "trusted")) root))
(check "what .quad/files names is part of it" (let ([fs (project-config-files root)])
                                                 (and (string-contains (cdr (assoc "servers.json" fs)) "fakelang")
                                                      (string-prefix? "[not read" (cdr (assoc "../escape" fs))))))
(define outside (open-file! (path-join dir "outside.txt")))
(check "not outside it" (and (= (get-var 'tab-width outside) 8) (not (buffer-local outside 'seen-by-project #f))))

;; A project in a project: the inner one asks too, and its settings win.
(define c (open-file! (path-join inner "c.txt")))
(redraw!)
(check "the inner one asks" (and (asked? "Trust this project?") (on-screen? (path-join root "sub"))))
(choose! "Trust it")
(check "both apply, the inner last" (and (= (get-var 'tab-width c) 5) (buffer-local c 'seen-by-project #f)))

;; Saving trims, as the project asks, and its hook runs.
(switch-to-buffer! a)
(buffer-insert! a (buffer-length a) "three\t \n\n\n")
(press! "enter")
(check "trimmed" (equal? (read-file-string (path-join root "a.txt")) "one\ntwo\nthree\n"))
(check "as one undo step" (begin (press! "z" "z") (string-suffix? "three\t \n\n\n" (buffer-contents))))
(check "its save hook" (= (get-var 'scroll-margin) 7))

;; Its own language server, from a JSON file in Claude Code's form, rooted
;; at the project and given its settings when it asks.
(define b (open-file! (path-join root "deep/b.fake")))
(define servers-json (read-file-string (path-join root "servers.json")))
(write-file! (path-join root "servers.json") (string-append servers-json " "))
(check "a change to a named file is a change" (not (project-trusted? root)))
(write-file! (path-join root "servers.json") servers-json)
(check "and back" (project-trusted? root))
(check "the project's server" (and (lsp-buffer-server b) (equal? (lsp-server-name (lsp-buffer-server b)) "fake")))
(run-until "its diagnostics" (lambda () (pair? (lsp-diagnostics b))))
(let ([r #f])
  (lsp-request! b "test/state" '() (lambda (x) (set! r x)))
  (run-until "the state" (lambda () r))
  (expect-equal "its settings, as it asked for them" (json-ref r 'configuration) '#(((x . 1)))))

;; A change to .quad/ asks again; until then the old configuration is gone.
(set-var! 'scroll-margin 3)
(write-file! (path-join root ".quad/init.ss") "(project-set! 'tab-width 4)\n")
(press! "space" "space")
(choose! "project-reload")
(check "changed: asked again" (asked? "Trust this project?"))
(check "unloaded meanwhile" (not (eq? (project-state root) 'loaded)))
(choose! "Trust it")
(check "the new one" (= (get-var 'tab-width a) 4))
(switch-to-buffer! a)
(buffer-insert! a 0 "zero\n")
(press! "enter")
(check "the old one's hooks are gone" (= (get-var 'scroll-margin) 3))
(run-until "the old server to stop" (lambda () (not (lsp-buffer-server b))))
(check "its server went with it" (not (exists (lambda (c) (equal? (lsp-server-name c) "fake")) (lsp-servers))))

;; Forgotten, it is no longer trusted.
(project-forget! root)
(check "forgotten" (and (not (project-trusted? root)) (eq? (project-state root) 'declined)))
(lsp-stop!)
(codex-stop!)
