;; link.ss -- links: URLs and Markdown's, their highlights, hovering and
;; following them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 60)

(define (urls b) (map caddr (buffer-links b 0 (buffer-length b))))
(define (texts b) (map (lambda (l) (text-substring (buffer-text b) (car l) (cadr l))) (buffer-links b 0 (buffer-length b))))

;; ---------------------------------------------------------------------------
;; Finding them

(define prose
  (headless-buffer!
   (string-append
    "See https://example.com/a_(b), or (http://x.org/path).\n"
    "Not a link: xhttps://nope or https:// alone; ftp://files.example/f.\n"
    "<https://quoted.example/q> and \"file:///tmp/a b\"\n"
    "https://first.example/x starts this line\n")
   'text))
(expect-equal "the URLs in prose, without what closes the sentence"
              (urls prose)
              '("https://first.example/x" "file:///tmp/a" "https://quoted.example/q" "ftp://files.example/f"
                "http://x.org/path" "https://example.com/a_(b)"))
(expect-equal "a link covers its URL" (car (reverse (texts prose))) "https://example.com/a_(b)")
(expect-equal "the link at a position" (link-at prose 6) (list 4 29 "https://example.com/a_(b)"))
(expect-equal "and none elsewhere" (link-at prose 2) #f)

(define md
  (let ([b (headless-buffer! "Read [the design](docs/design.md \"title\") or [web](<https://quad.example>).\n![a picture](/img/x.png)\n[](empty) [x]() [anchor](#top)\n" 'markdown)])
    (buffer-path-set! b "/work/notes/README.md")
    b))
(expect-equal "Markdown's links: text and target lead to the target, a path from the file's directory"
              (map (lambda (l) (list (text-substring (buffer-text md) (car l) (cadr l)) (caddr l)))
                   (sort (lambda (a b) (< (car a) (car b))) (buffer-links md 0 (buffer-length md))))
              '(("the design" "file:///work/notes/docs/design.md")
                ("docs/design.md" "file:///work/notes/docs/design.md")
                ("web" "https://quad.example")
                ("<https://quad.example>" "https://quad.example")
                ("https://quad.example" "https://quad.example")
                ("a picture" "file:///img/x.png")
                ("/img/x.png" "file:///img/x.png")
                ("empty" "file:///work/notes/empty")))

;; A path without a drive is no absolute one on Windows.
(if (eq? (path-style) 'windows)
    (begin
      (expect-equal "a file link's path and line" (file-link-path "file:///C:/a/b%20c.md#L12") '("C:/a/b c.md" . 12))
      (expect-equal "and without a line" (file-link-path "file://localhost/C:/a/b") '("C:/a/b" . #f)))
    (begin
      (expect-equal "a file link's path and line" (file-link-path "file:///a/b%20c.md#L12") '("/a/b c.md" . 12))
      (expect-equal "and without a line" (file-link-path "file://localhost/a/b") '("/a/b" . #f))))
(expect-equal "another URL is no file's" (file-link-path "https://x") #f)

;; ---------------------------------------------------------------------------
;; Highlights carry them; ctrl and the pointer underline one

(define model (make-grid-model))
(define c (server-connect! "gui" 12 60 '("pointer-shape" "open-url")
                           (lambda (m) (grid-model-apply! model m)) void))
(with-client c (lambda () (switch-to-buffer! prose)))
(redraw!)

;; Screen row 1 is the buffer's first line (row 0 has the buffer tabs);
;; the line numbers take 5 columns.
(define (cell-link col) (let ([hl (grid-model-hl model (cdr (grid-model-cell model 1 col)))]) (list-ref hl 4)))
(define cell-flags
  (case-lambda
   [(col) (cell-flags 1 col)]
   [(row col) (let ([hl (grid-model-hl model (cdr (grid-model-cell model row col)))]) (list-ref hl 2))]))
(expect-equal "a URL's cells' highlight has its link" (cell-link (+ 5 10)) "https://example.com/a_(b)")
(expect-equal "and others' none" (cell-link (+ 5 1)) #f)
(expect-equal "not underlined" (logand (cell-flags (+ 5 10)) 4) 0)

(define (pointers) (filter (lambda (m) (equal? (car m) "pointer")) (grid-model-other model)))
(client-receive! c (list "mouse" "move" 0 (+ 5 10) 1 0))
(redraw!)
(expect-equal "without ctrl, the pointer over a link is the text one" (car (pointers)) '("pointer" "text"))
(expect-equal "and it is not underlined" (logand (cell-flags (+ 5 10)) 4) 0)
(client-receive! c (list "mouse" "move" 0 (+ 5 11) 1 mod-ctrl))
(redraw!)
(expect-equal "with ctrl, a hand" (car (pointers)) '("pointer" "pointer"))
(expect-equal "and the link is underlined" (logand (cell-flags (+ 5 4)) 4) 4)
(expect-equal "all of it" (logand (cell-flags (+ 5 28)) 4) 4)
(expect-equal "and nothing else" (logand (cell-flags (+ 5 30)) 4) 0)
(client-receive! c (list "mouse" "move" 0 (+ 5 2) 1 mod-ctrl))
(redraw!)
(expect-equal "off it, the text pointer" (car (pointers)) '("pointer" "text"))
(expect-equal "and no underline" (logand (cell-flags (+ 5 10)) 4) 0)
(client-receive! c (list "mouse" "move" 0 (+ 5 1) 4 mod-ctrl))
(redraw!)
(expect-equal "a link at a line's start" (logand (cell-flags 4 (+ 5 1)) 4) 4)
(client-receive! c (list "mouse" "move" 0 1 4 mod-ctrl))
(redraw!)
(expect-equal "the gutter beside it is not over it" (logand (cell-flags 4 (+ 5 1)) 4) 0)

;; ---------------------------------------------------------------------------
;; Following them

(define (opened) (filter (lambda (m) (equal? (car m) "open-url")) (grid-model-other model)))
(client-receive! c (list "mouse" "press" 0 (+ 5 10) 1 mod-ctrl))
(client-receive! c (list "mouse" "release" 0 (+ 5 10) 1 mod-ctrl))
(redraw!)
(expect-equal "ctrl-click on a URL has the client open it" (opened) '(("open-url" "https://example.com/a_(b)")))
(expect-equal "and adds no cursor" (with-client c (lambda () (length (view-sels (current-view))))) 1)
(client-receive! c (list "mouse" "press" 0 (+ 5 1) 1 mod-ctrl))
(client-receive! c (list "mouse" "release" 0 (+ 5 1) 1 mod-ctrl))
(expect-equal "ctrl-click elsewhere still adds a cursor" (with-client c (lambda () (length (view-sels (current-view))))) 2)

(define dir (test-temp-dir "link"))
(define target (string-append dir "/target.md"))
(with-output-to-file target (lambda () (display "one\ntwo\nthree\nfour\n")))
(define here (headless-buffer! (format "[go](~a#L3)\n" target) 'markdown))
(with-client c (lambda () (switch-to-buffer! here) (set-sels! here (list (make-sel 1 2)))))
(with-client c (lambda () (run-command 'open-link)))
(redraw!)
(define now (with-client c (lambda () (current-buffer))))
(expect-equal "a file link opens the file here" (buffer-path now) target)
(expect-equal "at its line" (with-client c (lambda () (text-line-of (buffer-text now) (sel-start (primary))))) 2)
(expect-equal "the client is not asked to open it" (length (opened)) 1)

(define plain (server-connect! "plain" 12 60 '() void void))
(with-client plain (lambda () (switch-to-buffer! prose) (set-sels! prose (list (make-sel 10 11)))))
(with-client plain (lambda () (run-command 'open-link)))
(expect-equal "a client that cannot open URLs is shown it"
              (with-client plain (lambda () (cdr (current-message))))
              "Link: https://example.com/a_(b)")


;; However many links are drawn, their faces are kept for only so many.
(let ([many (headless-buffer! (apply string-append
                                     (map (lambda (i) (format "https://example.com/~a\n" i)) (iota 5000)))
                              'text)])
  (check "every link is found" (= 5000 (length (urls many))))
  (check "their faces are bounded" (<= (link-faces-count) 4096)))
