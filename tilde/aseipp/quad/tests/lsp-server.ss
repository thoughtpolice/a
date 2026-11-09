;; lsp-server.ss -- a stand-in language server, for lsp.ss
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad --batch runs it as a language server for *.fake files: JSON-RPC
;; after Content-Length headers on standard input and output, positions in
;; UTF-16 code units, documents kept in step by incremental changes. Words
;; are runs of letters, digits and _. It finds:
;;
;;   diagnostics   each "bad" is an error, each "meh" a warning
;;   hover         the word, as Markdown
;;   definition    the word's first occurrence (declaration: the same, as
;;                 a LocationLink), references every occurrence
;;   symbols       lines "def NAME", nested by indentation
;;   rename, code actions, formatting (trailing spaces), completion
;;
;; and answers "test/text" with its copy of a document, and "test/state"
;; with what the client told it.

(define in (standard-input-port))
(define out (standard-output-port))

(define (send! v)
  (let ([body (string->utf8 (json->string v))])
    (put-bytevector out (string->utf8 (format "Content-Length: ~a\r\n\r\n" (bytevector-length body))))
    (put-bytevector out body)
    (flush-output-port out)))

(define (read-message)
  (let loop ([header '()])
    (let ([b (get-u8 in)])
      (cond
       [(eof-object? b) (exit 0)]
       [(and (= b 10) (pair? header) (= (car header) 13) (pair? (cdr header)) (= (cadr header) 10))
        (let* ([text (utf8->string (u8-list->bytevector (reverse header)))]
               [n (string->number (string-trim (cadr (string-split (car (string-split text #\return)) #\:))))])
          (json-read-string (utf8->string (get-bytevector-n in n))))]
       [else (loop (cons b header))]))))

(define (reply id result) (send! `((jsonrpc . "2.0") (id . ,id) (result . ,result))))
(define (notify method params) (send! `((jsonrpc . "2.0") (method . ,method) (params . ,params))))
(define next-id 1000)
(define waiting '())                    ; id -> what to do with the answer
(define (ask method params k)
  (set! next-id (+ next-id 1))
  (set! waiting (cons (cons next-id k) waiting))
  (send! `((jsonrpc . "2.0") (id . ,next-id) (method . ,method) (params . ,params))))

;; ---------------------------------------------------------------------------
;; Documents, and UTF-16 positions in them

(define docs '())                       ; (uri . text)
(define (doc uri) (cond [(assoc uri docs) => cdr] [else ""]))
(define (doc-set! uri text) (set! docs (cons (cons uri text) (remp (lambda (d) (equal? (car d) uri)) docs))))

(define (units c) (if (> (char->integer c) #xFFFF) 2 1))

(define (offset text p)
  (let ([line (json-ref p 'line)] [ch (json-ref p 'character)] [n (string-length text)])
    (let find-line ([i 0] [l 0])
      (if (and (< l line) (< i n))
          (find-line (let skip ([i i]) (if (and (< i n) (not (char=? (string-ref text i) #\newline))) (skip (+ i 1)) (+ i 1)))
                     (+ l 1))
          (let walk ([i i] [u 0])
            (if (or (>= u ch) (>= i n) (char=? (string-ref text i) #\newline)) i
                (walk (+ i 1) (+ u (units (string-ref text i))))))))))

(define (position text i)
  (let loop ([j 0] [line 0] [u 0])
    (cond [(= j i) `((line . ,line) (character . ,u))]
          [(char=? (string-ref text j) #\newline) (loop (+ j 1) (+ line 1) 0)]
          [else (loop (+ j 1) line (+ u (units (string-ref text j))))])))

(define (range text s e) `((start . ,(position text s)) (end . ,(position text e))))

(define (word-char? c) (or (char-alphabetic? c) (char-numeric? c) (char=? c #\_)))

(define (word-at text i)
  (let* ([n (string-length text)]
         [s (let loop ([j i]) (if (and (> j 0) (word-char? (string-ref text (- j 1)))) (loop (- j 1)) j))]
         [e (let loop ([j i]) (if (and (< j n) (word-char? (string-ref text j))) (loop (+ j 1)) j))])
    (substring text s e)))

;; Where word occurs in text, as a whole word.
(define (occurrences text word)
  (let ([n (string-length text)] [m (string-length word)])
    (if (= m 0) '()
        (let loop ([i 0] [acc '()])
          (cond
           [(> (+ i m) n) (reverse acc)]
           [(and (string=? (substring text i (+ i m)) word)
                 (or (= i 0) (not (word-char? (string-ref text (- i 1)))))
                 (or (= (+ i m) n) (not (word-char? (string-ref text (+ i m))))))
            (loop (+ i m) (cons i acc))]
           [else (loop (+ i 1) acc)])))))

(define (diagnostics uri)
  (let ([text (doc uri)])
    (list->vector
     (sort (lambda (a b) (< (json-ref a 'range 'start 'line) (json-ref b 'range 'start 'line)))
           (append
            (map (lambda (i) `((range . ,(range text i (+ i 3))) (severity . 1) (source . "fake") (code . "B1")
                               (message . "bad is bad")))
                 (occurrences text "bad"))
            (map (lambda (i) `((range . ,(range text i (+ i 3))) (severity . 2) (source . "fake")
                               (message . "meh is meh")))
                 (occurrences text "meh")))))))

(define (publish! uri) (notify "textDocument/publishDiagnostics" `((uri . ,uri) (diagnostics . ,(diagnostics uri)))))

(define (location uri i len) `((uri . ,uri) (range . ,(range (doc uri) i (+ i len)))))

(define (symbols text)
  ;; ((indent name start) ...) for lines "def NAME"
  (let loop ([lines (string-split text #\newline)] [start 0] [acc '()])
    (if (null? lines)
        (reverse acc)
        (let* ([l (car lines)] [t (string-trim l)] [indent (- (string-length l) (string-length (string-trim-left l)))])
          (loop (cdr lines) (+ start (string-length l) 1)
                (if (string-prefix? "def " t)
                    (cons (list indent (substring t 4 (string-length t)) (+ start indent 4)) acc)
                    acc))))))

(define (document-symbols text)
  (let build ([syms (symbols text)] [indent 0])
    ;; The symbols at this indentation, each with the deeper ones after it.
    (let loop ([syms syms] [acc '()])
      (cond
       [(or (null? syms) (< (car (car syms)) indent)) (list->vector (reverse acc))]
       [else
        (let* ([s (car syms)]
               [kids (let take-deeper ([l (cdr syms)]) (if (and (pair? l) (> (car (car l)) (car s))) (cons (car l) (take-deeper (cdr l))) '()))]
               [rest (list-tail (cdr syms) (length kids))]
               [r (range text (caddr s) (+ (caddr s) (string-length (cadr s))))])
          (loop rest (cons `((name . ,(cadr s)) (kind . 12) (range . ,r) (selectionRange . ,r)
                             (children . ,(build kids (+ (car s) 1))))
                           acc)))]))))

;; ---------------------------------------------------------------------------
;; The client's requests

(define configuration #f)

(define (handle! m)
  (let ([id (json-ref m 'id)] [method (json-ref m 'method)] [params (json-ref m 'params)])
    (define (at) (let ([text (doc (json-ref params 'textDocument 'uri))])
                   (offset text (json-ref params 'position))))
    (define (uri) (json-ref params 'textDocument 'uri))
    (cond
     [(not method)
      ;; An answer to one of ours.
      (let ([w (assv id waiting)])
        (when w (set! waiting (remq w waiting)) ((cdr w) (json-ref m 'result))))]
     [(equal? method "initialize")
      (reply id `((capabilities
                   . ((textDocumentSync . ((openClose . #t) (change . 2) (save . ((includeText . #f)))))
                      (hoverProvider . #t) (definitionProvider . #t) (declarationProvider . #t)
                      (referencesProvider . #t) (renameProvider . #t) (documentFormattingProvider . #t)
                      (codeActionProvider . #t) (documentSymbolProvider . #t) (workspaceSymbolProvider . #t)
                      (completionProvider . ()) (executeCommandProvider . ((commands . #("fake.header"))))))
                  (serverInfo . ((name . "fake")))))]
     [(equal? method "initialized")
      (notify "$/progress" '((token . "t") (value . ((kind . "begin") (title . "indexing") (percentage . 0)))))
      (ask "workspace/configuration" '((items . #(((section . "fake")))))
           (lambda (r) (set! configuration r)))
      (notify "window/logMessage" '((type . 3) (message . "the fake server is up")))]
     [(equal? method "textDocument/didOpen")
      (doc-set! (json-ref params 'textDocument 'uri) (json-ref params 'textDocument 'text))
      (publish! (json-ref params 'textDocument 'uri))]
     [(equal? method "textDocument/didChange")
      (let ([u (uri)])
        (vector-for-each
         (lambda (ch)
           (let ([text (doc u)])
             (if (json-ref ch 'range)
                 (let ([s (offset text (json-ref ch 'range 'start))] [e (offset text (json-ref ch 'range 'end))])
                   (doc-set! u (string-append (substring text 0 s) (json-ref ch 'text) (substring text e (string-length text)))))
                 (doc-set! u (json-ref ch 'text)))))
         (json-ref params 'contentChanges))
        (publish! u))]
     [(member method '("textDocument/didSave" "textDocument/didClose")) (void)]
     [(equal? method "textDocument/hover")
      (let ([w (word-at (doc (uri)) (at))])
        (reply id (if (string=? w "") 'null
                      `((contents . ((kind . "markdown") (value . ,(format "```fake\n~a\n```\nA word, ~a long.\n" w (string-length w)))))))))]
     [(member method '("textDocument/definition" "textDocument/declaration"))
      (let* ([text (doc (uri))] [w (word-at text (at))] [os (occurrences text w)])
        (reply id (cond
                   [(null? os) 'null]
                   [(equal? method "textDocument/definition") (location (uri) (car os) (string-length w))]
                   [else (let ([r (range text (car os) (+ (car os) (string-length w)))])
                           `#(((targetUri . ,(uri)) (targetRange . ,r) (targetSelectionRange . ,r))))])))]
     [(equal? method "textDocument/references")
      (let ([w (word-at (doc (uri)) (at))])
        (reply id (list->vector
                   (apply append
                          (map (lambda (d) (map (lambda (i) (location (car d) i (string-length w))) (occurrences (cdr d) w)))
                               (reverse docs))))))]
     [(equal? method "textDocument/rename")
      (let ([w (word-at (doc (uri)) (at))] [new (json-ref params 'newName)])
        (reply id `((changes . ,(filter-map
                                 (lambda (d)
                                   (let ([os (occurrences (cdr d) w)])
                                     (and (pair? os)
                                          (cons (string->symbol (car d))
                                                (list->vector (map (lambda (i) `((range . ,(range (cdr d) i (+ i (string-length w))))
                                                                                 (newText . ,new)))
                                                                   os))))))
                                 docs)))))]
     [(equal? method "textDocument/codeAction")
      (let ([ds (vector->list (json-ref params 'context 'diagnostics))] [u (uri)])
        (reply id (list->vector
                   (append
                    (map (lambda (d)
                           `((title . "Replace bad with good") (kind . "quickfix") (isPreferred . #t)
                             (edit . ((documentChanges
                                       . #(((textDocument . ((uri . ,u) (version . null)))
                                            (edits . #(((range . ,(json-ref d 'range)) (newText . "good")))))))))))
                         (filter (lambda (d) (equal? (json-ref d 'code) "B1")) ds))
                    (list `((title . "Add a header") (command . "fake.header") (arguments . #(,u "// header"))))))))]
     [(equal? method "workspace/executeCommand")
      (let ([u (json-ref params 'arguments 0)] [line (json-ref params 'arguments 1)])
        (ask "workspace/applyEdit"
             `((label . "header")
               (edit . ((changes . ((,(string->symbol u) . #(((range . ((start . ((line . 0) (character . 0)))
                                                                         (end . ((line . 0) (character . 0)))))
                                                               (newText . ,(string-append line "\n"))))))))))
             (lambda (r) (reply id 'null))))]
     [(equal? method "textDocument/formatting")
      (let* ([text (doc (uri))]
             [edits (let loop ([i 0] [acc '()])
                      ;; Trailing spaces before each newline, and at the end.
                      (let ([nl (let find ([j i]) (cond [(= j (string-length text)) j] [(char=? (string-ref text j) #\newline) j] [else (find (+ j 1))]))])
                        (let ([s (let back ([j nl]) (if (and (> j i) (char=? (string-ref text (- j 1)) #\space)) (back (- j 1)) j))])
                          (let ([acc (if (< s nl) (cons `((range . ,(range text s nl)) (newText . "")) acc) acc)])
                            (if (>= nl (string-length text)) (reverse acc) (loop (+ nl 1) acc))))))])
        (reply id (list->vector edits)))]
     [(equal? method "textDocument/documentSymbol") (reply id (document-symbols (doc (uri))))]
     [(equal? method "workspace/symbol")
      (let ([q (json-ref params 'query)])
        (reply id (list->vector
                   (apply append
                          (map (lambda (d)
                                 (filter-map (lambda (s)
                                               (and (string-contains (cadr s) q)
                                                    `((name . ,(cadr s)) (kind . 12)
                                                      (location . ,(location (car d) (caddr s) (string-length (cadr s)))))))
                                             (symbols (cdr d))))
                               (reverse docs))))))]
     [(equal? method "textDocument/completion")
      (reply id `((isIncomplete . #f)
                  (items . #(((label . "alpha") (kind . 6) (sortText . "1"))
                             ((label . "alphabet") (kind . 6) (sortText . "2") (detail . "letters"))
                             ((label . "beta") (kind . 6) (sortText . "3"))
                             ((label . "gamma(x)") (kind . 3) (sortText . "4")
                              (insertText . "gamma(${1:x})") (insertTextFormat . 2))))))]
     [(equal? method "test/text") (reply id (doc (json-ref params 'uri)))]
     [(equal? method "test/state") (reply id `((configuration . ,(or configuration 'null))))]
     [(equal? method "shutdown") (reply id 'null)]
     [(equal? method "exit") (exit 0)]
     [id (send! `((jsonrpc . "2.0") (id . ,id) (error . ((code . -32601) (message . ,(format "no ~a" method))))))]
     [else (void)])))

(let loop ()
  (handle! (read-message))
  (loop))
