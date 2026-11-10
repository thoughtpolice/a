;; lsp.sls -- language servers: diagnostics, navigation, completion, refactoring
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad as a Language Server Protocol client. A server is chosen by file
;; extension (define-lsp-server!; clangd, rust-analyzer, gopls and others
;; are defined already, and used when their commands are on PATH), and one
;; runs per root, found by walking up from the file to a marker such as
;; .git or Cargo.toml. A server a project's .quad/init.ss defines is for
;; that project's files, ahead of the others (see (quad ext project)). Opening a file starts it; the buffer is kept
;; in step with it change by change; its diagnostics underline the text.
;;
;; The keys are Ki's:
;;
;;   n x  n X  n b  n c   definition, declaration, implementation, type
;;   n v  n V             references (without, with the declaration)
;;   n a  n s  n w        diagnostics as a selection mode: all, errors,
;;   n q  n Q             warnings, hints, information; then l and j
;;   space l s            hover
;;   space l f            rename
;;   space l d            code actions
;;   space l =            format the buffer
;;   space k y  space k Y symbols in the buffer, in the workspace
;;   space k e            every diagnostic, in every file
;;   ctrl+space           (insert mode) complete
(library (quad ext lsp)
  (export define-lsp-server! lsp-servers-from-json lsp-server-specs lsp-language-id-set!
          lsp-request! lsp-notify! lsp-buffer-server lsp-servers lsp-server-name
          lsp-server-capabilities lsp-diagnostics diag-start diag-end diag-severity diag-message
          lsp-stop! lsp-restart! lsp-log-lines
          lsp-position lsp-offset path->uri uri->path)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad json) (quad jsonrpc)
          (quad buffer) (quad selection) (quad editor) (quad commands) (quad display)
          (quad ext project) (only (quad main) quad-version))

  (define-variable lsp-enabled #t "Whether opening a file starts its language server")
  (define-variable lsp-log-file #f "A file for language servers' standard error, or #f")
  (define-variable lsp-diagnostic-messages #t
    "Whether landing on a diagnostic shows its message")

  ;; ---------------------------------------------------------------------------
  ;; Which server, for which files

  (define-record-type spec
    (fields name command extensions roots root require-root? config init-options languages scope))
  (define specs '())                    ; newest first
  (define (lsp-server-specs) specs)

  ;; Use command (a list of strings) for files with these extensions.
  ;; Properties follow, a symbol and its value each:
  ;;
  ;;   'roots '("Cargo.toml" ".git")  the root is the nearest directory up
  ;;                                  from the file holding one (default .git)
  ;;   'root "/path"                  or always this directory
  ;;   'require-root #t               no marker found: not this server
  ;;   'config json                   its settings, as Helix's `config`: the
  ;;                                  initializationOptions, and what it gets
  ;;                                  when it asks (workspace/configuration)
  ;;   'initialization-options json   other initializationOptions than config
  ;;   'languages '(("h" . "cpp"))    language IDs, by extension
  ;;
  ;; A later definition comes first, and one a project defines is for its
  ;; files only; a server whose command is not on PATH is passed over.
  (define (define-lsp-server! name command extensions . props)
    (define (prop key default)
      (let loop ([l props])
        (cond [(or (null? l) (null? (cdr l))) default]
              [(eq? (car l) key) (cadr l)]
              [else (loop (cddr l))])))
    (let ([scope (project-loading)])
      (set! specs (cons (make-spec name command extensions (prop 'roots '(".git")) (prop 'root #f)
                                   (prop 'require-root #f) (prop 'config #f) (prop 'initialization-options #f)
                                   (prop 'languages '()) scope)
                        (remp (lambda (s) (and (eq? (spec-name s) name) (equal? (spec-scope s) scope))) specs)))))

  ;; Define the servers a JSON file describes, in the form Claude Code's LSP
  ;; plugins use: {"name": {"command": ..., "args": [...],
  ;; "extensionToLanguage": {".rs": "rust"}, "initializationOptions": ...,
  ;; "settings": ...}}. Properties, as define-lsp-server! takes them, apply to
  ;; every one.
  (define (lsp-servers-from-json file . props)
    (for-each
     (lambda (entry)
       (let* ([name (car entry)] [d (cdr entry)]
              [langs (map (lambda (e) (cons (let ([x (symbol->string (car e))])
                                              (if (string-prefix? "." x) (substring x 1 (string-length x)) x))
                                            (cdr e)))
                          (or (json-ref d 'extensionToLanguage) '()))])
         (apply define-lsp-server! name
                (cons (json-ref d 'command) (json-list (json-ref d 'args)))
                (map car langs)
                (append props
                        (list 'languages langs)
                        (let ([init (json-ref d 'initializationOptions)] [settings (json-ref d 'settings)])
                          (append (if (or settings init) (list 'config (or settings init)) '())
                                  (if (and settings init) (list 'initialization-options init) '())))))))
     (json-read-string (read-file-string file))))

  (define language-ids
    '(("c" . "c") ("h" . "c") ("cc" . "cpp") ("cpp" . "cpp") ("cxx" . "cpp") ("hpp" . "cpp")
      ("hh" . "cpp") ("hxx" . "cpp") ("rs" . "rust") ("go" . "go") ("py" . "python")
      ("ts" . "typescript") ("tsx" . "typescriptreact") ("js" . "javascript")
      ("jsx" . "javascriptreact") ("zig" . "zig") ("sh" . "shellscript") ("bash" . "shellscript")
      ("nix" . "nix") ("lean" . "lean4") ("java" . "java") ("lua" . "lua") ("ml" . "ocaml")
      ("hs" . "haskell") ("swift" . "swift") ("kt" . "kotlin") ("cs" . "csharp")))
  (define (lsp-language-id-set! ext id)
    (set! language-ids (cons (cons ext id) (remp (lambda (e) (equal? (car e) ext)) language-ids))))

  (define (extension path)
    (let ([base (path-basename path)])
      (let loop ([i (- (string-length base) 1)])
        (cond [(< i 1) base]
              [(char=? (string-ref base i) #\.) (substring base (+ i 1) (string-length base))]
              [else (loop (- i 1))]))))

  (define (language-id sp path)
    (let ([e (extension path)])
      (cond [(assoc e (spec-languages sp)) => cdr] [(assoc e language-ids) => cdr] [else e])))

  (define (in-scope? sp path)
    (let ([scope (spec-scope sp)])
      (or (not scope)
          (and (member scope (project-roots path)) (eq? (project-state scope) 'loaded)))))

  ;; The nearest directory up from path's holding one of sp's root
  ;; markers, or #f.
  (define (marker-root sp path)
    (find (lambda (dir) (exists (lambda (m) (file-exists? (path-join dir m))) (spec-roots sp)))
          (ancestor-dirs (path-dirname path))))

  ;; The server for path: the innermost project's, then the newest.
  (define (spec-for path)
    (let* ([e (extension path)]
           [fits (filter (lambda (s) (and (member e (spec-extensions s)) (in-scope? s path)
                                          (or (not (spec-require-root? s)) (spec-root s) (marker-root s path))
                                          (find-executable (car (spec-command s)))))
                         specs)])
      (and (pair? fits)
           (let ([depth (lambda (s) (if (spec-scope s) (string-length (spec-scope s)) -1))])
             (fold-left (lambda (best s) (if (> (depth s) (depth best)) s best)) (car fits) (cdr fits))))))

  ;; The directory sp's server works in, for path: its own, the nearest
  ;; with one of its markers, else path's own directory.
  (define (spec-root-for sp path)
    (or (spec-root sp) (marker-root sp path) (path-dirname path)))

  ;; A server's settings for a workspace/configuration item: the part of
  ;; its config the section names, or all of it for the server's own name
  ;; (as rust-analyzer and gopls ask), else null.
  (define (config-section sp section)
    (let ([config (spec-config sp)])
      (cond
       [(not config) 'null]
       [(or (not section) (string=? section "") (string=? section (symbol->string (spec-name sp)))) config]
       [else (or (apply json-ref config (map string->symbol (string-split section #\.))) 'null)])))

  ;; ---------------------------------------------------------------------------
  ;; URIs

  (define (unreserved? c)
    (or (char<=? #\a c #\z) (char<=? #\A c #\Z) (char<=? #\0 c #\9) (memv c '(#\- #\. #\_ #\~ #\/))))

  (define (path->uri path)
    (string-append
     "file://"
     (apply string-append
            (map (lambda (c)
                   (if (unreserved? c)
                       (string c)
                       (apply string-append
                              (map (lambda (b) (string-append "%" (if (< b 16) "0" "") (string-upcase (number->string b 16))))
                                   (bytevector->u8-list (string->utf8 (string c)))))))
                 (string->list path)))))

  (define (uri->path uri)
    (percent-decode (if (string-prefix? "file://" uri) (substring uri 7 (string-length uri)) uri)))

  ;; ---------------------------------------------------------------------------
  ;; Positions: LSP's (line, character), the character counted in the
  ;; server's encoding -- UTF-16 code units unless it agrees to another.

  (define (code-units c encoding)
    (let ([n (char->integer c)])
      (case encoding
        [(utf-32) 1]
        [(utf-8) (cond [(< n #x80) 1] [(< n #x800) 2] [(< n #x10000) 3] [else 4])]
        [else (if (> n #xFFFF) 2 1)])))

  (define (lsp-position b pos encoding)
    (let* ([t (buffer-text b)] [pos (clamp pos 0 (text-length t))]
           [line (text-line-of t pos)] [start (text-line-start t line)])
      `((line . ,line)
        (character . ,(let loop ([i start] [n 0])
                        (if (>= i pos) n (loop (+ i 1) (+ n (code-units (text-ref t i) encoding)))))))))

  (define (lsp-offset b p encoding)
    (let* ([t (buffer-text b)] [lines (text-line-count t)]
           [line (or (json-ref p 'line) 0)] [ch (or (json-ref p 'character) 0)])
      (cond
       [(< line 0) 0]
       [(>= line lines) (text-length t)]
       [else
        (let ([end (text-line-end t line)])
          (let loop ([i (text-line-start t line)] [n 0])
            (if (or (>= i end) (>= n ch)) i (loop (+ i 1) (+ n (code-units (text-ref t i) encoding))))))])))

  (define (lsp-range b range encoding)
    (let ([s (lsp-offset b (json-ref range 'start) encoding)] [e (lsp-offset b (json-ref range 'end) encoding)])
      (cons (min s e) (max s e))))

  ;; ---------------------------------------------------------------------------
  ;; Servers: one per spec and root

  (define-record-type conn
    (fields spec root (mutable rpc) (mutable capabilities) (mutable encoding)
            (mutable ready?) (mutable waiting) (mutable buffers) (mutable progress)
            (mutable stopping?) (mutable watchers)))   ; registration id -> glob matchers

  (define conns '())
  (define (lsp-servers) conns)
  (define (lsp-server-name c) (symbol->string (spec-name (conn-spec c))))
  (define (lsp-server-capabilities c) (conn-capabilities c))

  (define log-lines '())
  (define log-count 0)
  ;; The last 2000 lines logged, oldest first.
  (define (lsp-log-lines) (reverse (take log-lines 2000)))
  ;; Trimmed back to 2000 lines once twice that are kept, not at every one.
  (define (log! fmt . args)
    (set! log-lines (cons (apply format fmt args) log-lines))
    (set! log-count (+ log-count 1))
    (when (> log-count 4000)
      (set! log-lines (take log-lines 2000))
      (set! log-count 2000)))

  ;; The server for buffer b, if it has one.
  (define (lsp-buffer-server b) (buffer-local b 'lsp-conn #f))

  (define (lsp-client-capabilities)
    `((general . ((positionEncodings . #("utf-32" "utf-16"))))
      (textDocument
       . ((synchronization . ((didSave . #t) (dynamicRegistration . #f)))
          (publishDiagnostics . ((relatedInformation . #f) (versionSupport . #t)))
          (hover . ((contentFormat . #("markdown" "plaintext"))))
          (completion . ((completionItem . ((snippetSupport . #f) (documentationFormat . #("plaintext"))))
                         (contextSupport . #t)))
          (definition . ((linkSupport . #t))) (declaration . ((linkSupport . #t)))
          (implementation . ((linkSupport . #t))) (typeDefinition . ((linkSupport . #t)))
          (references . ()) (rename . ((prepareSupport . #f)))
          (codeAction . ((codeActionLiteralSupport
                          . ((codeActionKind
                              . ((valueSet . #("" "quickfix" "refactor" "refactor.extract" "refactor.inline"
                                               "refactor.rewrite" "source" "source.organizeImports"))))))
                         (resolveSupport . ((properties . #("edit"))))))
          (formatting . ()) (documentSymbol . ((hierarchicalDocumentSymbolSupport . #t)))))
      (workspace . ((applyEdit . #t) (workspaceEdit . ((documentChanges . #t)))
                    (symbol . ()) (configuration . #t) (workspaceFolders . #t)
                    (executeCommand . ())))
      (window . ((workDoneProgress . #t) (showMessage . ()) (showDocument . ((support . #t)))))))

  (define (start-conn! sp root)
    (let ([c (make-conn sp root #f '() 'utf-16 #f '() '() '() #f '())])
      (guard (e [#t (message-error "~a would not start: ~a" (spec-name sp) (condition->string e))
                    (log! "~a would not start: ~a" (spec-name sp) (condition->string e))
                    #f])
        (conn-rpc-set! c (jsonrpc-start (spec-command sp) root (get-var 'lsp-log-file)
                                        (lambda (method params) (on-notification c method params))
                                        (lambda (rpc id method params) (on-request c id method params))
                                        (lambda (status) (on-exit c status))
                                        'headers))
        (set! conns (cons c conns))
        (log! "~a: starting in ~a" (spec-name sp) root)
        (jsonrpc-request!
         (conn-rpc c) "initialize"
         `((processId . null)
           (clientInfo . ((name . "quad") (version . ,quad-version)))
           (rootUri . ,(path->uri root)) (rootPath . ,root)
           (workspaceFolders . #(((uri . ,(path->uri root)) (name . ,(path-basename root)))))
           (capabilities . ,(lsp-client-capabilities))
           ,@(let ([init (or (spec-init-options sp) (spec-config sp))])
               (if init `((initializationOptions . ,init)) '())))
         (lambda (result)
           (conn-capabilities-set! c (or (json-ref result 'capabilities) '()))
           (conn-encoding-set! c (let ([e (json-ref result 'capabilities 'positionEncoding)])
                                   (cond [(equal? e "utf-32") 'utf-32] [(equal? e "utf-8") 'utf-8] [else 'utf-16])))
           (jsonrpc-notify! (conn-rpc c) "initialized" '())
           (when (spec-config sp)
             (jsonrpc-notify! (conn-rpc c) "workspace/didChangeConfiguration" `((settings . ,(spec-config sp)))))
           (conn-ready?-set! c #t)
           (let ([ks (reverse (conn-waiting c))])
             (conn-waiting-set! c '())
             (for-each (lambda (k) (k)) ks)))
         (lambda (e)
           (message-error "~a would not initialize: ~a" (spec-name sp) (jsonrpc-error-message e))
           (stop-conn! c)))
        c)))

  (define (when-ready c k)
    (if (conn-ready? c) (k) (conn-waiting-set! c (cons k (conn-waiting c)))))

  (define (on-exit c status)
    (set! conns (remq c conns))
    (for-each (lambda (b)
                (buffer-local-set! b 'lsp-conn #f)
                (buffer-local-set! b 'lsp-diagnostics '()))
              (conn-buffers c))
    (log! "~a exited (status ~a)" (lsp-server-name c) status)
    (unless (conn-stopping? c)
      (message-error "~a exited (status ~a); space space lsp-restart starts it again" (lsp-server-name c) status)))

  (define (stop-conn! c)
    (let ([rpc (conn-rpc c)])
      (conn-stopping?-set! c #t)
      (when (and rpc (jsonrpc-running? rpc))
        (guard (e [#t (void)])
          (when (conn-ready? c)
            (jsonrpc-request! rpc "shutdown" #f ignore ignore)
            (jsonrpc-notify! rpc "exit" #f)))
        (jsonrpc-stop! rpc 500))))

  ;; Stop every server.
  (define (lsp-stop!) (for-each stop-conn! conns))

  ;; Stop buffer b's server and start it again, for every buffer it had.
  (define (lsp-restart! b)
    (let* ([c (lsp-buffer-server b)] [bs (if c (conn-buffers c) (list b))])
      (when c (stop-conn! c))
      (for-each (lambda (b) (buffer-local-set! b 'lsp-tried #f) (attach! b)) bs)))

  ;; ---------------------------------------------------------------------------
  ;; Documents

  (define (buffer-uri b) (path->uri (buffer-path b)))

  (define (sync-kind c)
    (let ([s (json-ref (conn-capabilities c) 'textDocumentSync)])
      (cond [(number? s) s] [(json-object? s) (or (json-ref s 'change) 0)] [else 0])))

  ;; Give buffer b to its language server, starting one if need be.
  (define (attach! b)
    (let ([path (buffer-path b)])
      (when (and path (get-var 'lsp-enabled) (not (lsp-buffer-server b)) (not (buffer-local b 'lsp-tried #f))
                 ;; Not while its project waits for an answer about trust:
                 ;; the project may want another server, or none.
                 (not (exists (lambda (root) (memq (project-state root) '(unknown pending asking)))
                              (project-roots path))))
        (buffer-local-set! b 'lsp-tried #t)
        (let ([sp (spec-for path)])
          (when sp
            (let* ([root (spec-root-for sp path)]
                   [c (or (find (lambda (c) (and (eq? (conn-spec c) sp) (equal? (conn-root c) root)
                                                 (not (conn-stopping? c))))
                                conns)
                          (start-conn! sp root))])
              (when c
                (buffer-local-set! b 'lsp-conn c)
                (conn-buffers-set! c (cons b (conn-buffers c)))
                (when-ready c (lambda () (open-document! c b))))))))))

  (define (open-document! c b)
    (when (and (eq? (lsp-buffer-server b) c) (memq b (buffers)))
      (buffer-local-set! b 'lsp-version 0)
      (buffer-local-set! b 'lsp-open #t)
      (buffer-local-set! b 'lsp-uri (buffer-uri b))
      (jsonrpc-notify! (conn-rpc c) "textDocument/didOpen"
                       `((textDocument . ((uri . ,(buffer-uri b)) (languageId . ,(language-id (conn-spec c) (buffer-path b)))
                                          (version . 0) (text . ,(buffer-string b))))))))

  (define (detach! b)
    (let ([c (lsp-buffer-server b)])
      (when c
        (when (and (buffer-local b 'lsp-open #f) (jsonrpc-running? (conn-rpc c)))
          (jsonrpc-notify! (conn-rpc c) "textDocument/didClose"
                           `((textDocument . ((uri . ,(buffer-local b 'lsp-uri (buffer-uri b))))))))
        (conn-buffers-set! c (remq b (conn-buffers c)))
        (buffer-local-set! b 'lsp-conn #f)
        (buffer-local-set! b 'lsp-open #f))))

  (define (next-version! b)
    (let ([v (+ 1 (buffer-local b 'lsp-version 0))]) (buffer-local-set! b 'lsp-version v) v))

  ;; Every change, as it is made: sent at once, in the old text's
  ;; positions, last first, so that each holds as the server applies them
  ;; in turn. Servers that want the whole text get it once the command is
  ;; done (flush!).
  (define (on-change b changes)
    (let ([c (lsp-buffer-server b)])
      (when (pair? (lsp-diagnostics b)) (remap-diagnostics! b changes))
      (when (and c (buffer-local b 'lsp-open #f) (jsonrpc-running? (conn-rpc c)))
        (case (sync-kind c)
          [(2)
           (let ([enc (conn-encoding c)])
             (jsonrpc-notify!
              (conn-rpc c) "textDocument/didChange"
              `((textDocument . ((uri . ,(buffer-local b 'lsp-uri #f)) (version . ,(next-version! b))))
                (contentChanges
                 . ,(list->vector
                     (map (lambda (ch)
                            `((range . ((start . ,(lsp-position b (car ch) enc)) (end . ,(lsp-position b (cadr ch) enc))))
                              (text . ,(caddr ch))))
                          (reverse changes)))))))]
          [(1) (buffer-local-set! b 'lsp-stale #t)]
          [else (void)]))))

  (define (flush! b)
    (let ([c (lsp-buffer-server b)])
      (when (and c (buffer-local b 'lsp-stale #f) (jsonrpc-running? (conn-rpc c)))
        (buffer-local-set! b 'lsp-stale #f)
        (jsonrpc-notify! (conn-rpc c) "textDocument/didChange"
                         `((textDocument . ((uri . ,(buffer-local b 'lsp-uri #f)) (version . ,(next-version! b))))
                           (contentChanges . #(((text . ,(buffer-string b))))))))))

  (define (saved! b)
    (let ([c (lsp-buffer-server b)])
      (cond
       [(not c) (attach! b)]
       [(not (equal? (buffer-local b 'lsp-uri #f) (buffer-uri b)))
        ;; Saved under another name: a new document.
        (detach! b) (buffer-local-set! b 'lsp-tried #f) (attach! b)]
       [(and (buffer-local b 'lsp-open #f) (jsonrpc-running? (conn-rpc c)))
        (file-changed! (buffer-path b) 2)
        (flush! b)
        (let ([save (json-ref (conn-capabilities c) 'textDocumentSync 'save)])
          (when save
            (jsonrpc-notify! (conn-rpc c) "textDocument/didSave"
                             `((textDocument . ((uri . ,(buffer-uri b))))
                               ,@(if (json-ref save 'includeText) `((text . ,(buffer-string b))) '())))))])))

  ;; ---------------------------------------------------------------------------
  ;; Requests

  ;; Ask buffer b's server: (k result), as the client that asked. Fails
  ;; with a message if there is no server, or it can't (capability, a
  ;; key of its capabilities, is false).
  (define lsp-request!
    (case-lambda
     [(b method params k) (lsp-request! b method params k #f)]
     [(b method params k capability)
      (let ([c (lsp-buffer-server b)] [client (current-client)])
        (cond
         [(not c) (message-error "No language server for ~a" (buffer-name b))]
         [(not (conn-ready? c)) (message "~a is still starting" (lsp-server-name c))]
         [(and capability (not (json-ref (conn-capabilities c) capability)))
          (message-error "~a can't do that (no ~a)" (lsp-server-name c) capability)]
         [else
          (flush! b)
          (jsonrpc-request! (conn-rpc c) method params
                            (lambda (result) (as-client client (lambda () (k result))))
                            (lambda (e)
                              (as-client client
                                (lambda () (message-error "~a: ~a" (lsp-server-name c) (jsonrpc-error-message e))))))]))]))

  (define (lsp-notify! b method params)
    (let ([c (lsp-buffer-server b)])
      (when (and c (conn-ready? c)) (flush! b) (jsonrpc-notify! (conn-rpc c) method params))))

  (define (as-client client thunk)
    (if (and client (memq client (clients))) (with-client client thunk) (thunk)))

  (define (encoding-of b) (let ([c (lsp-buffer-server b)]) (if c (conn-encoding c) 'utf-16)))

  (define (cursor b) (sel-start (primary)))

  (define (document-position b)
    `((textDocument . ((uri . ,(buffer-uri b))))
      (position . ,(lsp-position b (cursor b) (encoding-of b)))))


  ;; A result that may be one object or an array of them, as a list.
  (define (as-list v) (cond [(vector? v) (vector->list v)] [(or (not v) (eq? v 'null)) '()] [(json-object? v) (list v)] [else '()]))

  ;; ---------------------------------------------------------------------------
  ;; Locations

  ;; The buffer for uri, opened if need be.
  (define (buffer-for-uri uri) (open-file! (uri->path uri)))

  (define (location-uri l) (or (json-ref l 'targetUri) (json-ref l 'uri)))
  (define (location-range l) (or (json-ref l 'targetSelectionRange) (json-ref l 'range)))

  ;; Show the location (a Location or LocationLink), selected.
  (define (goto-location! l)
    (let* ([b (buffer-for-uri (location-uri l))] [range (location-range l)])
      (push-selection-history! (current-buffer))
      (switch-to-buffer! b)
      (unless (selection-mode-of-text? (selection-mode-of b)) (set-selection-mode! b 'char))
      (when range
        (let ([r (lsp-range b range (encoding-of b))])
          (set-sels! (list (make-sel (car r) (max (cdr r) (min (buffer-length b) (+ 1 (car r)))))))))))

  ;; path as short as it can be: relative to a server's project root, or
  ;; else the working directory, when it is under one.
  (define (relative path)
    (let ([under (lambda (dir) (let ([d (path-join dir "")]) (and (string-prefix? d path) d)))])
      (let ([base (or (exists (lambda (c) (under (conn-root c))) conns) (under (current-directory)))])
        (if base (substring path (string-length base) (string-length path)) path))))

  ;; "file:line: the line's text", files' lines found in `files` (path ->
  ;; a buffer's text, or a vector of the file's lines), which keeps those
  ;; it finds.
  (define (location-label l files)
    (let* ([path (uri->path (location-uri l))]
           [line (or (json-ref (location-range l) 'start 'line) 0)]
           [text (line-text path line files)])
      (format "~a:~a: ~a" (relative path) (+ line 1) (string-trim text))))

  (define (line-text path line files)
    (let ([lines (or (hashtable-ref files path #f)
                     (let ([new (let ([b (find (lambda (b) (equal? (buffer-path b) path)) (buffers))])
                                  (cond
                                   [b (buffer-text b)]
                                   [(file-exists? path) (list->vector (string-split (read-file-string path) #\newline))]
                                   [else '#()]))])
                       (hashtable-set! files path new)
                       new))])
      (cond
       [(vector? lines) (if (< line (vector-length lines)) (vector-ref lines line) "")]
       [(< line (text-line-count lines)) (text-substring lines (text-line-start lines line) (text-line-end lines line))]
       [else ""])))

  (define (goto-locations! what result)
    (let ([ls (as-list result)])
      (cond
       [(null? ls) (message "No ~a found" what)]
       [(null? (cdr ls)) (goto-location! (car ls))]
       [else (let ([files (make-hashtable string-hash string=?)])
               (pick (format "~a (~a)" (string-titlecase* what) (length ls))
                     (map (lambda (l) (cons (location-label l files) l)) ls)
                     goto-location!))])))

  (define (string-titlecase* s)
    (if (string=? s "") s (string-append (string (char-upcase (string-ref s 0))) (substring s 1 (string-length s)))))

  (define (find-locations! method what capability . extra)
    (let ([b (current-buffer)])
      (lsp-request! b method (append (document-position b) extra)
                    (lambda (r) (goto-locations! what r))
                    capability)))

  ;; ---------------------------------------------------------------------------
  ;; Edits

  ;; Apply TextEdits to buffer b, as one undo step.
  (define (apply-text-edits! b edits encoding)
    (let ([changes (map (lambda (e)
                          (let ([r (lsp-range b (json-ref e 'range) encoding)])
                            (list (car r) (cdr r) (or (json-ref e 'newText) ""))))
                        edits)])
      (unless (null? changes)
        (buffer-begin-group! b)
        (buffer-edit! b changes)
        (buffer-end-group! b)
        (flush! b))
      (length changes)))

  ;; Apply a WorkspaceEdit from server c: the number of files changed.
  (define (apply-workspace-edit! c edit)
    (let ([files 0] [enc (conn-encoding c)])
      (define (edit-uri! uri edits)
        (let ([b (buffer-for-uri uri)])
          (when (> (apply-text-edits! b (as-list edits) (if (lsp-buffer-server b) (encoding-of b) enc)) 0)
            (set! files (+ files 1)))))
      (cond
       [(json-ref edit 'documentChanges)
        => (lambda (dcs)
             (for-each
              (lambda (dc)
                (let ([kind (json-ref dc 'kind)])
                  (cond
                   [(equal? kind "create")
                    (let ([p (uri->path (json-ref dc 'uri))])
                      (unless (file-exists? p) (write-file-string p "")))]
                   [(equal? kind "rename")
                    (let ([old (uri->path (json-ref dc 'oldUri))] [new (uri->path (json-ref dc 'newUri))])
                      (rename-file old new)
                      (let ([b (find (lambda (b) (equal? (buffer-path b) old)) (buffers))])
                        (when b (buffer-path-set! b new) (buffer-name-set! b (path-basename new)))))]
                   [(equal? kind "delete")
                    (let ([p (uri->path (json-ref dc 'uri))]) (when (file-exists? p) (delete-file p)))]
                   [else (edit-uri! (json-ref dc 'textDocument 'uri) (json-ref dc 'edits))])))
              (as-list dcs)))]
       [(json-ref edit 'changes)
        => (lambda (changes)
             (for-each (lambda (e) (edit-uri! (symbol->string (car e)) (cdr e))) changes))])
      files))

  (define (execute-command! b command)
    (lsp-request! b "workspace/executeCommand"
                  `((command . ,(json-ref command 'command))
                    ,@(let ([a (json-ref command 'arguments)]) (if a `((arguments . ,a)) '())))
                  ignore))

  ;; ---------------------------------------------------------------------------
  ;; Diagnostics

  (define-record-type diag (fields (mutable start) (mutable end) severity message raw))

  (define (lsp-diagnostics b) (buffer-local b 'lsp-diagnostics '()))

  ;; Every file's, by URI: the server's own objects.
  (define all-diagnostics (make-hashtable string-hash string=?))

  (define (publish-diagnostics! c params)
    (let* ([uri (json-ref params 'uri)] [ds (as-list (json-ref params 'diagnostics))]
           [path (uri->path uri)]
           [b (find (lambda (b) (and (equal? (buffer-path b) path) (eq? (lsp-buffer-server b) c))) (buffers))])
      (if (null? ds) (hashtable-delete! all-diagnostics uri) (hashtable-set! all-diagnostics uri ds))
      (when b
        (buffer-local-set!
         b 'lsp-diagnostics
         (sort (lambda (x y) (< (diag-start x) (diag-start y)))
               (map (lambda (d)
                      (let ([r (lsp-range b (json-ref d 'range) (conn-encoding c))])
                        (make-diag (car r) (cdr r) (or (json-ref d 'severity) 1)
                                   (or (json-ref d 'message) "") d)))
                    ds)))
        ;; A message about a diagnostic that is gone goes too.
        (for-each (lambda (cl)
                    (with-client cl
                      (lambda ()
                        (let ([said (hashtable-ref last-said cl #f)])
                          (when (and said (eq? (current-buffer) b) (not (memq said (lsp-diagnostics b))))
                            (hashtable-set! last-said cl #f)
                            (when (and (current-message) (equal? (cdr (current-message)) (diagnostic-text said)))
                              (clear-message!)))))))
                  (clients)))))

  ;; Diagnostics move with the text until the server sends new ones.
  (define (remap-diagnostics! b changes)
    (let ([mapped (position-mapper changes)])
      (for-each (lambda (d)
                  (diag-start-set! d (mapped (diag-start d)))
                  (diag-end-set! d (max (diag-start d) (mapped (diag-end d)))))
                (lsp-diagnostics b))))

  ;; How many of l pred holds for.
  (define (count pred l) (fold-left (lambda (n x) (if (pred x) (+ n 1) n)) 0 l))

  (define severity-faces '#(#f diagnostic.error diagnostic.warning diagnostic.info diagnostic.hint))
  (define severity-names '#(#f "error" "warning" "info" "hint"))
  (define (severity-index d) (clamp (diag-severity d) 1 4))

  ;; The diagnostics are sorted by where they start (and stay so as the
  ;; text moves them): none after one starting past end is drawn.
  (define (decorate b start end)
    (let loop ([ds (lsp-diagnostics b)] [acc '()])
      (if (or (null? ds) (>= (diag-start (car ds)) end))
          (reverse acc)
          (let* ([d (car ds)] [s (diag-start d)] [e (if (= (diag-end d) s) (+ s 1) (diag-end d))])
            (loop (cdr ds)
                  (if (> e start) (cons (list s e (vector-ref severity-faces (severity-index d))) acc) acc))))))

  ;; Diagnostics as selection modes: the units are the diagnostics of a
  ;; severity (or all), in order.
  (define (diagnostic-mode name label keep?)
    (define (ds b) (filter keep? (lsp-diagnostics b)))
    (define (range d) (cons (diag-start d) (max (diag-end d) (+ 1 (diag-start d)))))
    (make-selection-mode
     name label
     (lambda (b r)
       (let ([l (ds b)])
         (cond [(find (lambda (d) (<= (car r) (diag-start d))) l) => range]
               [(find (lambda (d) (< (car r) (diag-end d))) l) => range]
               [(pair? l) (range (car l))]
               [else #f])))
     (lambda (b r dir)
       (let ([l (ds b)])
         (case dir
           [(right next down) (let ([d (find (lambda (d) (> (diag-start d) (car r))) l)]) (and d (range d)))]
           [(left previous up) (let ([d (find (lambda (d) (< (diag-start d) (car r))) (reverse l))]) (and d (range d)))]
           [(first) (and (pair? l) (range (car l)))]
           [(last) (and (pair? l) (range (car (last-pair l))))]
           [else #f])))
     (lambda (b first last)
       (let* ([t (buffer-text b)] [lo (text-line-start t first)] [hi (text-line-end t last)])
         (map range (filter (lambda (d) (<= lo (diag-start d) hi)) (ds b)))))
     #f #f))

  (define (select-diagnostics! name)
    (let ([b (current-buffer)])
      (if (null? (filter (diagnostic-filter name) (lsp-diagnostics b)))
          (message "No ~a here" (cdr (assq name diagnostic-labels)))
          (select-mode! name))))

  (define diagnostic-labels
    '((diagnostic . "diagnostics") (diagnostic-error . "errors") (diagnostic-warning . "warnings")
      (diagnostic-info . "information") (diagnostic-hint . "hints")))

  (define (diagnostic-filter name)
    (case name
      [(diagnostic-error) (lambda (d) (= (severity-index d) 1))]
      [(diagnostic-warning) (lambda (d) (= (severity-index d) 2))]
      [(diagnostic-info) (lambda (d) (= (severity-index d) 3))]
      [(diagnostic-hint) (lambda (d) (= (severity-index d) 4))]
      [else (lambda (d) #t)]))

  (define (diagnostic-text d)
    (let ([src (json-ref (diag-raw d) 'source)] [code (json-ref (diag-raw d) 'code)])
      (format "~a: ~a~a" (vector-ref severity-names (severity-index d))
              (string-first-line (diag-message d))
              (cond [(and src code) (format " (~a ~a)" src code)] [src (format " (~a)" src)] [else ""]))))

  ;; Being on a diagnostic says what it is (each key clears the message,
  ;; so it is said again while nothing else is), for the current client.
  (define last-said (make-weak-eq-hashtable))
  (define (say-diagnostic!)
    (define client (current-client))
    (when (and client (get-var 'lsp-diagnostic-messages) (not (current-prompt)))
      (let* ([b (current-buffer)] [s (primary)]
             [here (filter (lambda (d) (and (< (diag-start d) (max (sel-range-end s) (+ 1 (sel-range-start s))))
                                            (>= (max (diag-end d) (+ 1 (diag-start d))) (+ 1 (sel-range-start s)))))
                           (lsp-diagnostics b))]
             [d (and (pair? here) (car (sort (lambda (x y) (< (severity-index x) (severity-index y))) here)))])
        (let ([said (hashtable-ref last-said client #f)])
          (unless (and (eq? d said) (or (not d) (current-message)))
            (hashtable-set! last-said client d)
            (cond
             [d (if (= (severity-index d) 1)
                    (message-error "~a" (diagnostic-text d))
                    (message "~a" (diagnostic-text d)))]
             ;; Off it, or it is fixed: its message goes, unless another
             ;; has taken its place.
             [(and said (current-message) (equal? (cdr (current-message)) (diagnostic-text said)))
              (clear-message!)]))))))

  (define (pick-all-diagnostics!)
    (let ([items (let-values ([(uris dss) (hashtable-entries all-diagnostics)])
                   (apply append
                          (map (lambda (uri ds)
                                 (map (lambda (d)
                                        (let ([line (or (json-ref d 'range 'start 'line) 0)])
                                          (cons (format "~a:~a: ~a: ~a" (relative (uri->path uri)) (+ line 1)
                                                        (vector-ref severity-names (clamp (or (json-ref d 'severity) 1) 1 4))
                                                        (string-first-line (or (json-ref d 'message) "")))
                                                `((uri . ,uri) (range . ,(json-ref d 'range))))))
                                      ds))
                               (vector->list uris) (vector->list dss))))])
      (if (null? items)
          (message "No diagnostics")
          (pick (format "Diagnostics (~a)" (length items)) (sort (lambda (a b) (string<? (car a) (car b))) items)
                goto-location!))))

  ;; ---------------------------------------------------------------------------
  ;; Hover

  ;; Markdown (or plain text) as popup lines: code blocks in code's face.
  (define (markup->lines contents)
    (define (block text code?)
      (let loop ([ls (string-split text #\newline)] [code? code?] [acc '()])
        (cond
         [(null? ls) (reverse acc)]
         [(string-prefix? "```" (string-trim (car ls))) (loop (cdr ls) (not code?) acc)]
         [else (loop (cdr ls) code? (cons (cons (car ls) (if code? 'markup.raw 'ui.popup)) acc))])))
    (let ([lines (cond
                  [(string? contents) (block contents #f)]
                  [(vector? contents) (apply append (map markup->lines (vector->list contents)))]
                  [(json-ref contents 'kind) (block (or (json-ref contents 'value) "") #f)]
                  [(json-ref contents 'language) (block (or (json-ref contents 'value) "") #t)]
                  [else '()])])
      ;; No blank lines at either end.
      (let ([trim (lambda (l) (let loop ([l l]) (if (and (pair? l) (string=? (string-trim (car (car l))) "")) (loop (cdr l)) l)))])
        (reverse (trim (reverse (trim lines)))))))

  (define (hover!)
    (let ([b (current-buffer)])
      (lsp-request! b "textDocument/hover" (document-position b)
                    (lambda (r)
                      (let ([lines (if (json-ref r 'contents) (markup->lines (json-ref r 'contents)) '())])
                        (if (null? lines)
                            (message "Nothing to say about this")
                            (show-popup! (make-popup "Hover" (lambda () lines) "esc hide")))))
                    'hoverProvider)))

  ;; ---------------------------------------------------------------------------
  ;; Rename, code actions, formatting

  (define (word-at b pos)
    (let* ([t (buffer-text b)] [word? (syntax-word-char? (major-mode-syntax (buffer-major-mode b)))]
           [n (text-length t)]
           [s (let loop ([i pos]) (if (and (> i 0) (word? (text-ref t (- i 1)))) (loop (- i 1)) i))]
           [e (let loop ([i pos]) (if (and (< i n) (word? (text-ref t i))) (loop (+ i 1)) i))])
      (text-substring t s e)))

  (define (rename!)
    (let* ([b (current-buffer)] [c (lsp-buffer-server b)] [s (primary)]
           [selected (selection-text b s)]
           [old (if (and (> (string-length selected) 0) (not (string-index selected #\newline))) selected (word-at b (cursor b)))])
      (if (and c (not (json-ref (conn-capabilities c) 'renameProvider)))
          (message-error "~a can't rename" (lsp-server-name c))
          (read-string-dialog "Rename" (format "A new name for ~a" old) old
                              (lambda (new)
                                (unless (or (string=? (string-trim new) "") (string=? new old))
                                  (lsp-request! b "textDocument/rename" (append (document-position b) `((newName . ,new)))
                                                (lambda (edit)
                                                  (if (or (not edit) (eq? edit 'null))
                                                      (message "Nothing to rename")
                                                      (let ([n (apply-workspace-edit! c edit)])
                                                        (message "Renamed ~a to ~a in ~a file~a" old new n (if (= n 1) "" "s")))))
                                                'renameProvider)))))))

  (define (code-actions!)
    (let* ([b (current-buffer)] [c (lsp-buffer-server b)] [s (primary)] [enc (encoding-of b)]
           [lo (sel-range-start s)] [hi (sel-range-end s)]
           [here (filter (lambda (d) (and (<= (diag-start d) (max hi (+ lo 1))) (>= (diag-end d) lo))) (lsp-diagnostics b))])
      (lsp-request!
       b "textDocument/codeAction"
       `((textDocument . ((uri . ,(buffer-uri b))))
         (range . ((start . ,(lsp-position b lo enc)) (end . ,(lsp-position b hi enc))))
         (context . ((diagnostics . ,(list->vector (map diag-raw here))) (triggerKind . 1))))
       (lambda (r)
         (let ([actions (as-list r)])
           (if (null? actions)
               (message "No code actions here")
               (pick "Code actions"
                     (map (lambda (a) (cons (string-append (or (json-ref a 'title) "?")
                                                           (if (json-ref a 'isPreferred) "  ★" ""))
                                            a))
                          actions)
                     (lambda (a) (run-code-action! c b a))))))
       'codeActionProvider)))

  (define (run-code-action! c b a)
    (let ([cmd (json-ref a 'command)])
      (cond
       ;; A Command itself.
       [(string? cmd) (execute-command! b a)]
       [(json-ref a 'edit)
        => (lambda (edit) (apply-workspace-edit! c edit) (when cmd (execute-command! b cmd)))]
       [cmd (execute-command! b cmd)]
       [(json-ref (conn-capabilities c) 'codeActionProvider 'resolveProvider)
        (lsp-request! b "codeAction/resolve" a
                      (lambda (resolved)
                        (if (or (json-ref resolved 'edit) (json-ref resolved 'command))
                            (run-code-action! c b resolved)
                            (message "That action did nothing"))))]
       [else (message "That action did nothing")])))

  (define (format-buffer!)
    (let* ([b (current-buffer)] [version (buffer-version b)])
      (lsp-request! b "textDocument/formatting"
                    `((textDocument . ((uri . ,(buffer-uri b))))
                      (options . ((tabSize . ,(get-var 'tab-width b))
                                  (insertSpaces . ,(not (string-index (get-var 'indent-unit b) #\tab))))))
                    (lambda (edits)
                      (cond
                       [(not (= version (buffer-version b))) (message "The buffer changed: format it again")]
                       [(null? (as-list edits)) (message "Already formatted")]
                       [else (apply-text-edits! b (as-list edits) (encoding-of b)) (message "Formatted")]))
                    'documentFormattingProvider)))

  ;; ---------------------------------------------------------------------------
  ;; Symbols

  (define symbol-kinds
    '#("" "file" "module" "namespace" "package" "class" "method" "property" "field" "constructor"
       "enum" "interface" "function" "variable" "constant" "string" "number" "boolean" "array"
       "object" "key" "null" "enum member" "struct" "event" "operator" "type parameter"))
  (define (kind-name k) (if (and (fixnum? k) (< 0 k (vector-length symbol-kinds))) (vector-ref symbol-kinds k) ""))

  (define (document-symbols!)
    (let ([b (current-buffer)])
      (lsp-request! b "textDocument/documentSymbol" `((textDocument . ((uri . ,(buffer-uri b)))))
                    (lambda (r)
                      (let ([items (let flatten ([syms (as-list r)] [depth 0])
                                     (apply append
                                            (map (lambda (s)
                                                   (cons (cons (format "~a~a  ~a" (make-string (* 2 depth) #\space)
                                                                       (json-ref s 'name) (kind-name (json-ref s 'kind)))
                                                               (if (json-ref s 'location)
                                                                   (json-ref s 'location)
                                                                   `((uri . ,(buffer-uri b))
                                                                     (range . ,(or (json-ref s 'selectionRange) (json-ref s 'range))))))
                                                         (flatten (as-list (json-ref s 'children)) (+ depth 1))))
                                                 syms)))])
                        (if (null? items)
                            (message "No symbols")
                            (pick (format "Symbols (~a)" (length items)) items goto-location!))))
                    'documentSymbolProvider)))

  (define (workspace-symbols!)
    (let ([b (current-buffer)])
      (read-string-dialog "Workspace symbol" "A name, or part of one" (word-at b (cursor b))
                          (lambda (query)
                            (lsp-request! b "workspace/symbol" `((query . ,query))
                                          (lambda (r)
                                            (let ([syms (as-list r)])
                                              (if (null? syms)
                                                  (message "No symbols match ~s" query)
                                                  (pick (format "Symbols matching ~s (~a)" query (length syms))
                                                        (map (lambda (s)
                                                               (let ([l (json-ref s 'location)])
                                                                 (cons (format "~a  ~a  ~a" (json-ref s 'name) (kind-name (json-ref s 'kind))
                                                                               (relative (uri->path (json-ref l 'uri))))
                                                                       l)))
                                                             syms)
                                                        goto-location!))))
                                          'workspaceSymbolProvider)))))

  ;; ---------------------------------------------------------------------------
  ;; Completion: a menu at the cursor. What is typed goes into the text and
  ;; narrows the menu; enter takes the choice, escape leaves the text as
  ;; typed.

  (define (strip-snippet s)
    ;; $1, $0, ${1:text} -> text, ${1|a,b|} -> a, \$ -> $
    (let loop ([i 0] [acc '()])
      (define n (string-length s))
      (cond
       [(>= i n) (list->string (reverse acc))]
       [(and (char=? (string-ref s i) #\\) (< (+ i 1) n)) (loop (+ i 2) (cons (string-ref s (+ i 1)) acc))]
       [(and (char=? (string-ref s i) #\$) (< (+ i 1) n) (char-numeric? (string-ref s (+ i 1))))
        (loop (let skip ([j (+ i 1)]) (if (and (< j n) (char-numeric? (string-ref s j))) (skip (+ j 1)) j)) acc)]
       [(and (char=? (string-ref s i) #\$) (< (+ i 1) n) (char=? (string-ref s (+ i 1)) #\{))
        (let* ([close (let find ([j (+ i 2)] [depth 1])
                        (cond [(>= j n) n]
                              [(char=? (string-ref s j) #\{) (find (+ j 1) (+ depth 1))]
                              [(char=? (string-ref s j) #\}) (if (= depth 1) j (find (+ j 1) (- depth 1)))]
                              [else (find (+ j 1) depth)]))]
               [inner (substring s (+ i 2) (min close n))]
               [colon (string-index inner #\:)] [bar (string-index inner #\|)]
               [text (cond [colon (strip-snippet (substring inner (+ colon 1) (string-length inner)))]
                           [bar (let ([opts (substring inner (+ bar 1) (string-length inner))])
                                  (car (string-split (if (string-suffix? "|" opts) (substring opts 0 (- (string-length opts) 1)) opts) #\,)))]
                           [else ""])])
          (loop (+ close 1) (append (reverse (string->list text)) acc)))]
       [else (loop (+ i 1) (cons (string-ref s i) acc))])))

  (define (item-text item)
    (let* ([edit (json-ref item 'textEdit)]
           [text (or (and edit (json-ref edit 'newText)) (json-ref item 'insertText) (json-ref item 'label) "")])
      (if (eqv? (json-ref item 'insertTextFormat) 2) (strip-snippet text) text)))

  (define (complete!)
    (let* ([b (current-buffer)] [word? (syntax-word-char? (major-mode-syntax (buffer-major-mode b)))])
      (lsp-request!
       b "textDocument/completion" (append (document-position b) '((context . ((triggerKind . 1)))))
       (lambda (r)
         (let* ([items (as-list (if (json-ref r 'items) (json-ref r 'items) r))]
                [items (sort (lambda (x y) (string<? (or (json-ref x 'sortText) (json-ref x 'label) "")
                                                     (or (json-ref y 'sortText) (json-ref y 'label) "")))
                             items)]
                [t (buffer-text b)] [pos (cursor b)]
                [start (let loop ([i pos]) (if (and (> i 0) (word? (text-ref t (- i 1)))) (loop (- i 1)) i))]
                [typed (text-substring t start pos)]
                [shown typed]
                ;; Labels as servers pad them (clangd's start with a space,
                ;; or • for one that adds an #include), trimmed.
                [candidates (map (lambda (i) (cons (string-trim (or (json-ref i 'label) "?")) i)) items)])
           (cond
            [(not (eq? (current-buffer) b)) (void)]
            [(null? items) (message "No completions")]
            [else
             (open-prompt!
              (make-prompt
               #f typed (lambda (input) candidates)
               (lambda (item)
                 (when (json-object? item)
                   (let* ([enc (encoding-of b)] [edit (json-ref item 'textEdit)]
                          [range (and edit (or (json-ref edit 'range) (json-ref edit 'replace)))]
                          [from (if range (min start (lsp-offset b (json-ref range 'start) enc)) start)]
                          [to (+ start (string-length shown))]
                          [text (item-text item)])
                     (buffer-edit! b (list (list from to text)))
                     (set-sels! (list (make-sel (+ from (string-length text)) (+ from (string-length text)))))
                     (let ([more (as-list (json-ref item 'additionalTextEdits))])
                       (when (pair? more) (apply-text-edits! b more enc))))))
               ;; Mirror the input into the text; a character that is not
               ;; part of a word ends completing.
               (lambda (input)
                 (unless (string=? input shown)
                   (let ([at (+ start (string-length shown))])
                     (buffer-edit! b (list (list start at input)))
                     (set! shown input)
                     (set-sels! (list (make-sel (+ start (string-length input)) (+ start (string-length input)))))
                     (when (or (string=? input "") (exists (lambda (ch) (not (word? ch))) (string->list input)))
                       (close-prompt!)))))
               'menu))])))
       'completionProvider)))

  ;; ---------------------------------------------------------------------------
  ;; What servers say and ask

  (define (on-notification c method params)
    (cond
     [(string=? method "textDocument/publishDiagnostics") (publish-diagnostics! c params)]
     [(string=? method "window/showMessage")
      (let ([text (or (json-ref params 'message) "")] [type (or (json-ref params 'type) 4)])
        (log! "~a: ~a" (lsp-server-name c) text)
        (for-each (lambda (cl) (with-client cl (lambda () (if (= type 1) (message-error "~a: ~a" (lsp-server-name c) text)
                                                               (message "~a: ~a" (lsp-server-name c) text)))))
                  (clients)))]
     [(string=? method "window/logMessage")
      (log! "~a: ~a" (lsp-server-name c) (or (json-ref params 'message) ""))]
     [(string=? method "$/progress")
      (let ([token (json-ref params 'token)] [v (json-ref params 'value)])
        (conn-progress-set!
         c (if (equal? (json-ref v 'kind) "end")
               (remp (lambda (p) (equal? (car p) token)) (conn-progress c))
               (let ([old (assoc token (conn-progress c))])
                 (cons (cons token
                             (list (or (json-ref v 'title) (and old (cadr old)) "")
                                   (json-ref v 'message) (json-ref v 'percentage)))
                       (remp (lambda (p) (equal? (car p) token)) (conn-progress c)))))))]
     [else (void)]))

  (define (on-request c id method params)
    (let ([rpc (conn-rpc c)])
      (cond
       [(string=? method "workspace/configuration")
        (jsonrpc-reply! rpc id (list->vector (map (lambda (item) (config-section (conn-spec c) (json-ref item 'section)))
                                                  (as-list (json-ref params 'items)))))]
       [(string=? method "client/registerCapability")
        (for-each (lambda (r) (register! c r)) (as-list (json-ref params 'registrations)))
        (jsonrpc-reply! rpc id 'null)]
       [(string=? method "client/unregisterCapability")
        (for-each (lambda (r) (conn-watchers-set! c (remp (lambda (w) (equal? (car w) (json-ref r 'id))) (conn-watchers c))))
                  (as-list (or (json-ref params 'unregisterations) (json-ref params 'unregistrations))))
        (jsonrpc-reply! rpc id 'null)]
       [(string=? method "window/workDoneProgress/create") (jsonrpc-reply! rpc id 'null)]
       [(string=? method "workspace/workspaceFolders")
        (jsonrpc-reply! rpc id `#(((uri . ,(path->uri (conn-root c))) (name . ,(path-basename (conn-root c))))))]
       [(string=? method "workspace/applyEdit")
        (let ([n (guard (e [#t #f]) (apply-workspace-edit! c (json-ref params 'edit)))])
          (jsonrpc-reply! rpc id (if n '((applied . #t)) '((applied . #f) (failureReason . "it would not apply")))))]
       [(string=? method "window/showDocument")
        (with-client-or-any #f (lambda () (goto-location! `((uri . ,(json-ref params 'uri)) (range . ,(json-ref params 'selection))))))
        (jsonrpc-reply! rpc id '((success . #t)))]
       [(string=? method "window/showMessageRequest")
        (let ([actions (as-list (json-ref params 'actions))])
          (if (null? actions)
              (begin (with-client-or-any #f (lambda () (message "~a: ~a" (lsp-server-name c) (json-ref params 'message))))
                     (jsonrpc-reply! rpc id 'null))
              (with-client-or-any #f
                (lambda ()
                  (pick (lsp-server-name c) (map (lambda (a) (cons (json-ref a 'title) a)) actions)
                        (lambda (a) (jsonrpc-reply! rpc id (if (json-object? a) a 'null)))
                        'picker (json-ref params 'message))))))]
       [else (jsonrpc-reply-error! rpc id -32601 (format "quad does not handle ~a" method))])))

  ;; ---------------------------------------------------------------------------
  ;; Watched files: a server can ask to hear of changes to files matching
  ;; globs (rust-analyzer, of BUILD files, to rediscover the project). quad
  ;; tells it of the files it saves.

  (define (register! c r)
    (when (equal? (json-ref r 'method) "workspace/didChangeWatchedFiles")
      (conn-watchers-set!
       c (cons (cons (json-ref r 'id)
                     (filter-map (lambda (w)
                                   (let ([g (json-ref w 'globPattern)])
                                     (cond
                                      [(string? g) (glob-matcher (if (or (string-prefix? "/" g) (string-prefix? "**" g)) g (string-append "**/" g)))]
                                      [(json-ref g 'pattern)
                                       => (lambda (pat)
                                            (let ([base (let ([b (json-ref g 'baseUri)]) (if (string? b) b (json-ref b 'uri)))])
                                              (glob-matcher (path-join (uri->path (or base "")) pat))))]
                                      [else #f])))
                                 (as-list (json-ref r 'registerOptions 'watchers))))
                 (conn-watchers c)))))

  ;; A glob as a predicate on paths: ** any run of directories, * any run
  ;; of characters but /, ? one of them, {a,b} either.
  (define (glob-matcher glob)
    (lambda (path)
      (let match ([g (string->list glob)] [p (string->list path)])
        (cond
         [(null? g) (null? p)]
         [(and (char=? (car g) #\*) (pair? (cdr g)) (char=? (cadr g) #\*))
          (let* ([rest (cddr g)] [rest (if (and (pair? rest) (char=? (car rest) #\/)) (cdr rest) rest)])
            (let loop ([p p])
              (or (match rest p)
                  (and (pair? p) (loop (cdr p))))))]
         [(char=? (car g) #\*)
          (let loop ([p p])
            (or (match (cdr g) p)
                (and (pair? p) (not (char=? (car p) #\/)) (loop (cdr p)))))]
         [(char=? (car g) #\{)
          (let* ([close (let find ([l (cdr g)] [acc '()]) (cond [(null? l) #f] [(char=? (car l) #\}) (cons (reverse acc) (cdr l))] [else (find (cdr l) (cons (car l) acc))]))])
            (if close
                (exists (lambda (alt) (match (append (string->list alt) (cdr close)) p))
                        (string-split (list->string (car close)) #\,))
                (and (pair? p) (char=? (car p) #\{) (match (cdr g) (cdr p)))))]
         [(null? p) #f]
         [(char=? (car g) #\?) (and (not (char=? (car p) #\/)) (match (cdr g) (cdr p)))]
         [else (and (char=? (car g) (car p)) (match (cdr g) (cdr p)))]))))

  (define (file-changed! path kind)
    (for-each (lambda (c)
                (when (and (conn-ready? c) (exists (lambda (w) (exists (lambda (m) (m path)) (cdr w))) (conn-watchers c)))
                  (jsonrpc-notify! (conn-rpc c) "workspace/didChangeWatchedFiles"
                                   `((changes . #(((uri . ,(path->uri path)) (type . ,kind))))))))
              conns))

  ;; ---------------------------------------------------------------------------
  ;; Projects: their servers come and go with them

  (define (project-loaded! root)
    ;; Each of the project's buffers to the server it should now have.
    (for-each (lambda (b)
                (let ([path (buffer-path b)])
                  (when (and path (member root (project-roots path)))
                    (let ([c (lsp-buffer-server b)] [sp (spec-for path)])
                      (unless (and c (eq? (conn-spec c) sp))
                        (detach! b)
                        (buffer-local-set! b 'lsp-tried #f)
                        (attach! b))))))
              (buffers))
    (stop-unused!))

  (define (project-unloaded! root)
    (set! specs (remp (lambda (s) (equal? (spec-scope s) root)) specs))
    (for-each (lambda (c)
                (unless (memq (conn-spec c) specs)
                  (for-each (lambda (b) (detach! b) (buffer-local-set! b 'lsp-tried #f)) (conn-buffers c))))
              conns))

  ;; Servers left with no buffers, whose definition is gone, stop.
  (define (stop-unused!)
    (for-each (lambda (c) (when (and (null? (conn-buffers c)) (not (memq (conn-spec c) specs))) (stop-conn! c)))
              conns))

  ;; ---------------------------------------------------------------------------
  ;; The status line: the server, its progress, and the diagnostics' count.

  (define (status-segment v)
    (let* ([b (view-buffer v)] [c (lsp-buffer-server b)])
      (and c
           (let* ([ds (lsp-diagnostics b)]
                  [e (count (lambda (d) (= (severity-index d) 1)) ds)]
                  [w (count (lambda (d) (= (severity-index d) 2)) ds)]
                  [p (and (pair? (conn-progress c)) (cdr (car (conn-progress c))))])
             (cons (string-append
                    (if (> e 0) (format " ✖ ~a" e) "")
                    (if (> w 0) (format " ▲ ~a" w) "")
                    " " (lsp-server-name c)
                    (cond [(not (conn-ready? c)) " …"]
                          [p (format ": ~a~a~a" (car p) (if (cadr p) (format " ~a" (cadr p)) "")
                                     (if (caddr p) (format " ~a%" (caddr p)) ""))]
                          [else ""])
                    " ")
                   'ui.statusline.dim)))))

  ;; ---------------------------------------------------------------------------
  ;; Commands and keys

  (define (show-log!)
    (show-text-buffer! "*lsp*" (string-join (lsp-log-lines) "\n") 'fundamental))

  (define (show-info!)
    (message "~a"
             (if (null? conns)
                 "No language servers are running"
                 (string-join (map (lambda (c) (format "~a in ~a (~a, ~a buffer~a)" (lsp-server-name c) (conn-root c)
                                                       (conn-encoding c) (length (conn-buffers c))
                                                       (if (= (length (conn-buffers c)) 1) "" "s")))
                                   conns)
                              "; "))))

  (at-load
   (for-each
    (lambda (s) (define-lsp-server! (car s) (cadr s) (caddr s) 'roots (cadddr s)))
    (reverse
     '((clangd ("clangd") ("c" "h" "cc" "cpp" "cxx" "hpp" "hh" "hxx")
               ("compile_commands.json" "compile_flags.txt" ".clangd" ".git"))
       (rust-analyzer ("rust-analyzer") ("rs") ("Cargo.toml" ".git"))
       (gopls ("gopls") ("go") ("go.work" "go.mod" ".git"))
       (pyright ("pyright-langserver" "--stdio") ("py") ("pyproject.toml" "setup.py" "setup.cfg" ".git"))
       (pylsp ("pylsp") ("py") ("pyproject.toml" "setup.py" "setup.cfg" ".git"))
       (typescript-language-server ("typescript-language-server" "--stdio") ("ts" "tsx" "js" "jsx")
                                   ("tsconfig.json" "jsconfig.json" "package.json" ".git"))
       (zls ("zls") ("zig") ("build.zig" ".git"))
       (bash-language-server ("bash-language-server" "start") ("sh" "bash") (".git"))
       (nixd ("nixd") ("nix") ("flake.nix" ".git"))
       (lean ("lake" "serve") ("lean") ("lakefile.lean" "lakefile.toml" "lean-toolchain")))))
   (add-hook! 'project-load-hook project-loaded!)
   (add-hook! 'project-declined-hook project-loaded!)
   (add-hook! 'project-unload-hook project-unloaded!)
   (for-each define-selection-mode!
             (list (diagnostic-mode 'diagnostic "DIAGNOSTIC" (diagnostic-filter 'diagnostic))
                   (diagnostic-mode 'diagnostic-error "ERROR" (diagnostic-filter 'diagnostic-error))
                   (diagnostic-mode 'diagnostic-warning "WARNING" (diagnostic-filter 'diagnostic-warning))
                   (diagnostic-mode 'diagnostic-info "INFO" (diagnostic-filter 'diagnostic-info))
                   (diagnostic-mode 'diagnostic-hint "HINT" (diagnostic-filter 'diagnostic-hint))))
   (add-change-listener! on-change)
   (add-decorator! decorate)
   (add-hook! 'find-file-hook attach!)
   (add-hook! 'after-save-hook saved!)
   (add-hook! 'kill-buffer-hook detach!)
   (add-hook! 'post-command-hook
              (lambda (command)
                (for-each flush! (buffers))
                (say-diagnostic!)))
   (add-hook! 'kill-editor-hook lsp-stop!)
   (define-status-segment! 'right status-segment)

   (define-command 'lsp-definition "Go to the definition (language server)"
     (lambda () (find-locations! "textDocument/definition" "definition" 'definitionProvider)))
   (define-command 'lsp-declaration "Go to the declaration (language server)"
     (lambda () (find-locations! "textDocument/declaration" "declaration" 'declarationProvider)))
   (define-command 'lsp-implementation "Go to the implementations (language server)"
     (lambda () (find-locations! "textDocument/implementation" "implementation" 'implementationProvider)))
   (define-command 'lsp-type-definition "Go to the type's definition (language server)"
     (lambda () (find-locations! "textDocument/typeDefinition" "type definition" 'typeDefinitionProvider)))
   (define-command 'lsp-references "References, without the declaration (language server)"
     (lambda () (find-locations! "textDocument/references" "reference" 'referencesProvider
                                 '(context . ((includeDeclaration . #f))))))
   (define-command 'lsp-references-all "References, with the declaration (language server)"
     (lambda () (find-locations! "textDocument/references" "reference" 'referencesProvider
                                 '(context . ((includeDeclaration . #t))))))
   (for-each (lambda (name)
               (define-command (string->symbol (format "select-~a" name))
                 (format "Select ~a (language server); then l and j go between them"
                         (cdr (assq name diagnostic-labels)))
                 (lambda () (select-diagnostics! name))))
             '(diagnostic diagnostic-error diagnostic-warning diagnostic-info diagnostic-hint))
   (define-command 'lsp-hover "What the language server says about this" hover!)
   (define-command 'lsp-rename "Rename this, everywhere (language server)" rename!)
   (define-command 'lsp-code-actions "Fixes and refactorings for this (language server)" code-actions!)
   (define-command 'lsp-format "Format the buffer (language server)" format-buffer!)
   (define-command 'lsp-document-symbols "Go to a symbol in the buffer (language server)" document-symbols!)
   (define-command 'lsp-workspace-symbols "Go to a symbol in the workspace (language server)" workspace-symbols!)
   (define-command 'lsp-diagnostics "Every diagnostic, in every file (language server)" pick-all-diagnostics!)
   (define-command 'lsp-complete "Complete the word at the cursor (language server)" complete!)
   (define-command 'lsp-restart "Restart the buffer's language server"
     (lambda () (lsp-restart! (current-buffer)) (message "Restarting")))
   (define-command 'lsp-stop "Stop every language server" (lambda () (lsp-stop!) (message "Stopped them")))
   (define-command 'lsp-log "What language servers have said, in a buffer" show-log!)
   (define-command 'lsp-info "The language servers that are running" show-info!)

   (let ([context (keymap-lookup-target space-keymap "l")] [pick-menu (keymap-lookup-target space-keymap "k")])
     (define-key local-keymap "x" 'lsp-definition "Def")
     (define-key local-keymap "X" 'lsp-declaration "Decl")
     (define-key local-keymap "b" 'lsp-implementation "Impl")
     (define-key local-keymap "c" 'lsp-type-definition "Type")
     (define-key local-keymap "v" 'lsp-references "Ref-")
     (define-key local-keymap "V" 'lsp-references-all "Ref+")
     (define-key local-keymap "a" 'select-diagnostic "All Diags")
     (define-key local-keymap "s" 'select-diagnostic-error "Error")
     (define-key local-keymap "w" 'select-diagnostic-warning "Warn")
     (define-key local-keymap "q" 'select-diagnostic-hint "Hint")
     (define-key local-keymap "Q" 'select-diagnostic-info "Info")
     (define-key context "s" 'lsp-hover "Hover")
     (define-key context "f" 'lsp-rename "Rename")
     (define-key context "d" 'lsp-code-actions "Code Actions")
     (define-key context "=" 'lsp-format "Format")
     (define-key pick-menu "y" 'lsp-document-symbols "Symbol (Document)")
     (define-key pick-menu "Y" 'lsp-workspace-symbols "Symbol (Workspace)")
     (define-key pick-menu "e" 'lsp-diagnostics "Diagnostics")
     (define-key insert-keymap "ctrl+space" 'lsp-complete "Complete"))))
