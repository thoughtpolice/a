;; lsp.ss -- the language server client, against a stand-in server
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; QUAD_TEST_DIR is this directory; QUAD_LSP_DIR an empty directory, the
;; project the stand-in (lsp-server.ss) serves.

(define here (getenv "QUAD_TEST_DIR"))
(define work (getenv "QUAD_LSP_DIR"))


(define (bottom) (list-ref (screen) 29))
(define (select! b text n)
  ;; Select the nth occurrence of text in b, in CHAR mode.
  (let loop ([from 0] [n n])
    (let ([i (string-contains (buffer-string b) text from)])
      (if (= n 0)
          (begin (set-selection-mode! b 'char) (set-primary! (make-sel i (+ i (string-length text)))))
          (loop (+ i 1) (- n 1))))))
(define (sel) (primary-text))
(define (await-prompt name) (run-until name (lambda () (current-prompt))))
(define (await-move name) (let ([from (sel-start (primary))]) (run-until name (lambda () (not (= (sel-start (primary)) from))))))

;; The server's copy of b's text.
(define (server-text b)
  (let ([r #f])
    (lsp-request! b "test/text" `((uri . ,(path->uri (buffer-path b)))) (lambda (x) (set! r x)))
    (run-until "the server's text" (lambda () r))
    r))

(define (work-file! name text) (write-file! (path-join work name) text))
(work-file! ".fakeroot" "")
(work-file! "a.fake" "def top\n  def inner\nfoo = 1\n😀 bad meh foo\nprint(foo)   \n")
(work-file! "b.fake" "use foo\n")

(define-lsp-server! 'fake (list (quad-self-path) "-q" "--batch" (path-join here "lsp-server.ss")) '("fake") 'roots '(".fakeroot"))
(headless-start! 30 100)
(define a (open-file! (path-join work "a.fake")))
(define b (open-file! (path-join work "b.fake")))
(switch-to-buffer! a)
(check "a server" (lsp-buffer-server a))
(check "one, for both" (eq? (lsp-buffer-server a) (lsp-buffer-server b)))
(run-until "diagnostics" (lambda () (= (length (lsp-diagnostics a)) 2)))
(check "the status line" (and (on-screen? "✖ 1 ▲ 1 fake") (on-screen? "fake: indexing 0%")))
(expect-equal "UTF-16 positions" (let ([d (car (lsp-diagnostics a))]) (buffer-substring a (diag-start d) (diag-end d))) "bad")

;; Diagnostics, as selection modes.
(set-primary! (make-sel 0 1))
(press! "n" "a")
(check "the first diagnostic" (and (equal? (sel) "bad") (on-screen? "DIAGNOSTIC")))
(check "what it says" (string-contains (bottom) "error: bad is bad (fake B1)"))
(press! "l")
(check "the next" (and (equal? (sel) "meh") (string-contains (bottom) "warning: meh is meh")))
(press! "n" "s")
(check "errors only" (and (equal? (sel) "bad") (on-screen? "ERROR")))
(press! "W" "k")
(check "off it, its message goes" (not (string-contains (bottom) "bad is bad")))

;; Hover.
(select! a "foo" 0)
(press! "space" "l" "s")
(run-until "hover" (lambda () (current-popup)))
(check "hover" (and (on-screen? "Hover") (on-screen? "A word, 3 long.")))
(press! "esc")
(check "esc hides it" (not (on-screen? "A word")))

;; Definition, declaration, references.
(select! a "foo" 2)
(press! "n" "x")
(await-move "definition")
(check "definition" (and (equal? (sel) "foo") (= (sel-start (primary)) (string-contains (buffer-string a) "foo"))))
(select! a "foo" 2)
(press! "n" "X")
(await-move "declaration")
(check "declaration, a LocationLink" (= (sel-start (primary)) (string-contains (buffer-string a) "foo")))
(press! "n" "v")
(await-prompt "references")
(check "references, in both files" (and (on-screen? "Reference (4)") (on-screen? "a.fake:3: foo = 1")
                                        (on-screen? "b.fake:1: use foo")))
(type! "use")
(press! "enter")
(check "to one" (and (eq? (current-buffer) b) (equal? (sel) "foo")))
(switch-to-buffer! a)

;; Symbols.
(press! "space" "k" "y")
(await-prompt "symbols")
(check "symbols, nested" (and (on-screen? "top  function") (on-screen? "  inner  function")))
(type! "inner")
(press! "enter")
(check "to a symbol" (equal? (sel) "inner"))
(press! "space" "k" "Y")
(check "a workspace symbol query" (and (current-prompt) (equal? (prompt-input (current-prompt)) "inner")))
(press! "enter")
(await-prompt "workspace symbols")
(check "workspace symbols" (on-screen? "Symbols matching \"inner\" (1)"))
(press! "enter")
(check "to it" (equal? (sel) "inner"))

;; Code actions: an edit, and a command that edits through the client.
(select! a "bad" 0)
(press! "n" "s")
(check "on the error" (string-contains (bottom) "bad is bad"))
(press! "space" "l" "d")
(await-prompt "code actions")
(check "code actions" (and (on-screen? "Replace bad with good  ★") (on-screen? "Add a header")))
(press! "enter")
(check "the quick fix" (string-contains (buffer-string a) "😀 good meh"))
(run-until "the error to go" (lambda () (= (length (lsp-diagnostics a)) 1)))
(check "and its message" (not (string-contains (bottom) "bad is bad")))
(press! "space" "l" "d")
(await-prompt "code actions again")
(press! "enter")
(run-until "the header" (lambda () (string-prefix? "// header\n" (buffer-string a))))

;; Formatting.
(press! "space" "l" "=")
(run-until "formatting" (lambda () (string-contains (buffer-string a) "print(foo)\n")))
(check "formatted" (string-contains (bottom) "Formatted"))

;; Rename, in both files.
(select! a "foo" 0)
(press! "space" "l" "f")
(check "a rename dialog" (and (current-prompt) (equal? (prompt-input (current-prompt)) "foo")))
(press! "ctrl+u")
(type! "bar")
(press! "enter")
(run-until "the rename" (lambda () (string-contains (buffer-string b) "use bar")))
(check "renamed" (and (not (string-contains (buffer-string a) "foo")) (string-contains (bottom) "in 2 files")))

;; The server's copy keeps up with edits, past characters UTF-16 counts
;; twice, and with undo.
(select! a "meh" 0)
(press! "h")
(type! "🎉 x ")
(press! "esc")
(select! a "bar" 1)
(press! "s" "r" "r")
(press! "a" "r" "r")
(press! "z" "z")
(expect-equal "in step" (server-text a) (buffer-string a))
(expect-equal "in step too" (server-text b) (buffer-string b))

;; Completion: a menu at the cursor, narrowed by what is typed, which goes
;; into the text.
(select! a "print" 0)
(press! "a" "g" "k")
(type! "al")
(press! "ctrl+space")
(await-prompt "completions")
(check "a menu" (and (on-screen? "alpha") (on-screen? "alphabet") (not (on-screen? "beta"))))
(type! "p")
(check "typed into the text" (string-contains (buffer-string a) "\nalp\n"))
(press! "enter")
(check "completed" (and (string-contains (buffer-string a) "\nalpha\n") (not (current-prompt))
                        (eq? (view-input-mode (current-view)) 'insert)))
(press! "enter")
(type! "ga")
(press! "ctrl+space")
(await-prompt "a snippet")
(press! "enter")
(check "a snippet, as text" (string-contains (buffer-string a) "\ngamma(x)\n"))
(press! "enter")
(type! "be")
(press! "ctrl+space")
(await-prompt "completions to leave")
(type! "t")
(press! "esc")
(check "escape leaves the text" (and (string-contains (buffer-string a) "\nbet\n") (not (current-prompt))
                                     (eq? (view-input-mode (current-view)) 'insert)))
(press! "esc")
(expect-equal "in step after completing" (server-text a) (buffer-string a))

;; Every diagnostic, in every file.
(press! "space" "k" "e")
(await-prompt "all diagnostics")
(check "all diagnostics" (and (on-screen? "Diagnostics (1)") (on-screen? "warning: meh is meh")))
(press! "esc")

;; What the server asked and said.
(let ([r #f])
  (lsp-request! a "test/state" '() (lambda (x) (set! r x)))
  (run-until "the state" (lambda () r))
  (expect-equal "configuration answered" (json-ref r 'configuration) '#(null)))
(check "its log" (exists (lambda (l) (string-contains l "the fake server is up")) (lsp-log-lines)))

;; Stopping.
(lsp-stop!)
(run-until "the server to stop" (lambda () (null? (lsp-servers))))
(check "detached" (and (not (lsp-buffer-server a)) (null? (lsp-diagnostics a))))
