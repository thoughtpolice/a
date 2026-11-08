;; codex.sls -- an agent that changes and extends the editor: Codex's app server
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Ask for a change to the editor itself -- a command, a key, a theme, a
;; mode -- and an agent makes it: it edits your configuration, applies it to
;; the running editor, and checks it. quad is the client of OpenAI Codex's
;; app server (`codex app-server`), a JSON-RPC peer on a pipe (quad
;; jsonrpc), and gives the agent tools of its own: evaluating Scheme in the
;; editor, describing commands, variables and keys, reloading the init file.
;; The agent works in the init file's directory, under the sandbox and
;; approval policy set below; it asks before anything else, in a picker.
;;
;;   space a a    ask (while it works: steer it)
;;   space a p    show or hide the popup that follows it
;;   space a y    answer a waiting approval
;;   space a i    interrupt it
;;   space a t    the whole conversation, in a buffer
;;   space a n    a new conversation
;;   space a s    stop the app server
;;
;; More tools, for the agent to use from the next conversation on:
;;
;;   (define-codex-tool! "word_count" "Count the words in the current buffer"
;;     '((type . "object") (properties))
;;     (lambda (args) (number->string (length (string-split (buffer-string (current-buffer)) #\space)))))
(library (quad ext codex)
  (export codex-ask! codex-start! codex-stop! codex-interrupt! codex-new-thread!
          codex-running? codex-busy? codex-thread-id codex-approvals codex-approve!
          codex-transcript-text codex-popup define-codex-tool! codex-tools
          codex-instructions)
  (import (chezscheme) (quad util) (quad json) (quad jsonrpc) (quad text)
          (quad buffer) (quad editor) (quad commands) (quad display)
          (only (quad main) quad-version))

  (define-variable codex-command '("codex" "app-server")
    "The command line of Codex's app server, a list of strings")
  (define-variable codex-model #f "The model Codex uses, or #f for its default")
  (define-variable codex-sandbox "workspace-write"
    "Where Codex's commands may write: \"read-only\", \"workspace-write\" (its directory) or \"danger-full-access\"")
  (define-variable codex-approval-policy "on-request"
    "When Codex asks before running a command: \"untrusted\", \"on-request\" or \"never\"")
  (define-variable codex-directory #f
    "The directory Codex works in, or #f for the init file's")
  (define-variable codex-log #f "A file for the app server's standard error, or #f")

  ;; ---------------------------------------------------------------------------
  ;; State: one app server and one conversation, for the whole editor. A
  ;; turn belongs to the client that asked; its popup, approvals and tools
  ;; are that client's.

  (define rpc #f)
  (define initialized? #f)
  (define thread-id #f)
  (define thread-starting? #f)
  (define turn-id #f)
  (define busy? #f)
  (define stopping? #f)
  (define turn-client #f)
  (define waiting '())          ; thunks to run once a thread is ready
  (define approvals '())        ; (id label choices), oldest first

  (define (codex-running?) (and rpc #t))
  (define (codex-busy?) busy?)
  (define (codex-thread-id) thread-id)
  (define (codex-approvals) approvals)

  ;; The conversation, as the popup shows it: newest first.
  (define-record-type entry (fields kind (mutable text) (mutable face)))
  (define entries '())
  (define items (make-hashtable string-hash string=?))   ; item id -> entry

  (define (add-entry! kind text face)
    (let ([e (make-entry kind text face)])
      (set! entries (cons e entries))
      e))

  ;; The entry for item id, made with text and face if it is new.
  (define (item-entry! id kind text face)
    (or (and id (hashtable-ref items id #f))
        (let ([e (add-entry! kind text face)])
          (when id (hashtable-set! items id e))
          e)))

  (define (codex-transcript-text)
    (string-join (map entry-text (reverse entries)) "\n\n"))

  (define (clip s n)
    (if (> (string-length s) n) (string-append (substring s 0 n) "…") s))

  ;; The client things happen as: the one that asked, while it is here.
  (define (asking-client)
    (cond [(and turn-client (memq turn-client (clients))) turn-client]
          [(pair? (clients)) (car (clients))]
          [else #f]))

  (define (as-asker thunk)
    (let ([c (asking-client)])
      (if c (with-client c thunk) (thunk))))

  ;; ---------------------------------------------------------------------------
  ;; The popup

  (define (popup-contents)
    (if (null? entries)
        (list (cons "Ask for a change to quad: space a a." 'ui.popup.info))
        (let loop ([es (reverse entries)] [acc '()])
          (if (null? es)
              (reverse acc)
              (let* ([e (car es)]
                     [line (cons (list->string (map (lambda (c) (if (char=? c #\tab) #\space c))
                                                    (string->list (entry-text e))))
                                 (entry-face e))])
                (loop (cdr es)
                      (if (and (eq? (entry-kind e) 'user) (pair? acc))
                          (cons* line (cons "" 'ui.popup) acc)
                          (cons line acc))))))))

  (define codex-popup
    (make-popup (lambda () (cond [(pair? approvals) "Codex · approval needed"]
                                 [busy? "Codex · working"]
                                 [else "Codex"]))
                popup-contents
                (lambda () (cond [(pair? approvals) "space a y approve"]
                                 [busy? "space a a steer · space a i interrupt · esc hide"]
                                 [else "space a a ask · esc hide"]))))

  ;; ---------------------------------------------------------------------------
  ;; Tools: what the agent can do in the editor

  (define-record-type tool (fields name description schema proc))
  (define tools '())
  (define (codex-tools) tools)

  ;; A tool named name (a string) for the agent, described by description,
  ;; with arguments described by schema (a JSON Schema, as a JSON value).
  ;; (proc arguments) is its result, a string (or a value, written); an
  ;; error is a failed call, the error its result. It runs as the client
  ;; that asked. Tools are fixed when a conversation starts: a new one has
  ;; them.
  (define (define-codex-tool! name description schema proc)
    (set! tools (append (remp (lambda (t) (string=? (tool-name t) name)) tools)
                        (list (make-tool name description schema proc)))))

  (define (tool-spec t)
    `((type . "function") (name . ,(tool-name t)) (description . ,(tool-description t))
      (inputSchema . ,(tool-schema t))))

  (define (object-schema . properties)
    `((type . "object")
      (properties . ,(map (lambda (p) `(,(car p) . ((type . "string") (description . ,(cadr p))))) properties))
      (required . ,(list->vector (map (lambda (p) (symbol->string (car p))) properties)))
      (additionalProperties . #f)))

  (define (call-tool name args)
    (let ([t (find (lambda (t) (string=? (tool-name t) name)) tools)])
      (let-values ([(ok? text)
                    (if t
                        (guard (e [#t (values #f (condition->string e))])
                          (let ([r (as-asker (lambda () ((tool-proc t) args)))])
                            (values #t (if (string? r) r (format "~s" r)))))
                        (values #f (format "quad has no tool ~a" name)))])
        `((contentItems . #(((type . "inputText") (text . ,(clip text 20000)))))
          (success . ,ok?)))))

  ;; Every keymap reachable from the roots, depth first: (f path keymap),
  ;; path a list of names ("normal" "space" "l").
  (define (walk-keymaps f)
    (let ([seen (make-eq-hashtable)])
      (for-each
       (lambda (root)
         (let walk ([km (cdr root)] [path (list (car root))])
           (unless (hashtable-ref seen km #f)
             (hashtable-set! seen km #t)
             (f (reverse path) km)
             (for-each (lambda (e)
                         (when (keymap? (binding-target (cdr e)))
                           (walk (binding-target (cdr e)) (cons (car e) path))))
                       (keymap-entries km)))))
       `(("normal" . ,normal-keymap) ("insert" . ,insert-keymap) ("prompt" . ,prompt-keymap)
         ("global" . ,global-keymap)))))

  (define (keys-for command)
    (let ([found '()])
      (walk-keymaps
       (lambda (path km)
         (for-each (lambda (e)
                     (when (eq? (binding-target (cdr e)) command)
                       (set! found (cons (string-join (append path (list (car e))) " ") found))))
                   (keymap-entries km))))
      (reverse found)))

  (define (target->string t)
    (cond [(symbol? t) (symbol->string t)]
          [(keymap? t) (format "keymap ~a" (keymap-name t))]
          [else "a procedure"]))

  (define (tool-describe name)
    (let* ([sym (string->symbol name)]
           [cmd (find-command sym)]
           [bound? (top-level-bound? sym (quad-environment))]
           [parts
            (filter
             values
             (list
              (and cmd
                   (format "command ~a: ~a~a" name (command-doc cmd)
                           (let ([keys (keys-for sym)])
                             (if (null? keys) "; no keys" (format "; keys: ~a" (string-join keys ", "))))))
              (and (memq sym (variable-names))
                   (format "variable ~a = ~s: ~a" name (get-var sym) (variable-doc sym)))
              (and bound?
                   (let ([v (top-level-value sym (quad-environment))]
                         [libs (filter (lambda (l) (memq sym (library-exports l))) (quad-libraries))])
                     (format "~a ~a~a" (if (procedure? v) "procedure" "value") name
                             (if (null? libs) ", defined at top level" (format ", from ~s" libs)))))))])
      (if (null? parts)
          (format "Nothing is named ~a; try quad_apropos." name)
          (string-join parts "\n"))))

  (define (tool-apropos pattern)
    (let* ([pat (string-downcase pattern)]
           [match? (lambda (s) (string-contains (string-downcase (symbol->string s)) pat))]
           [lines
            (append
             (map (lambda (c) (format "command ~a: ~a" c (command-doc (find-command c))))
                  (sort-symbols (filter match? (command-names))))
             (map (lambda (v) (format "variable ~a: ~a" v (variable-doc v)))
                  (sort-symbols (filter match? (variable-names))))
             (apply append
                    (map (lambda (lib)
                           (map (lambda (s) (format "~a, from ~s" s lib))
                                (sort-symbols (filter match? (library-exports lib)))))
                         (filter (lambda (l) (eq? (car l) 'quad)) (quad-libraries)))))])
      (cond [(null? lines) (format "Nothing matches ~s." pattern)]
            [(> (length lines) 200) (string-append (string-join (take lines 200) "\n") "\n…and more; narrow the pattern.")]
            [else (string-join lines "\n")])))

  (define (sort-symbols l) (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) l))

  (define (describe-keymap path)
    (let ([words (string-split (string-trim path) #\space)])
      (let ([km (let follow ([km (cond [(null? words) #f]
                                       [(assoc (car words) `(("normal" . ,normal-keymap) ("insert" . ,insert-keymap)
                                                             ("prompt" . ,prompt-keymap) ("global" . ,global-keymap)
                                                             ("space" . ,space-keymap)))
                                        => cdr]
                                       [else #f])]
                                 [keys (if (null? words) '() (cdr words))])
                  (cond [(or (not km) (null? keys)) km]
                        [(keymap-lookup-target km (car keys))
                         => (lambda (t) (and (keymap? t) (follow t (cdr keys))))]
                        [else #f]))])
        (if km
            (string-join
             (cons (format "~a (~a):" path (keymap-title km))
                   (map (lambda (e)
                          (format "  ~a → ~a (~a)" (car e) (target->string (binding-target (cdr e)))
                                  (binding-label (cdr e))))
                        (keymap-entries km)))
             "\n")
            (format "No keymap ~s: give a root (normal, insert, prompt, global, space) and keys, as \"normal space l\"." path)))))

  (define (reload-config)
    (let ([path (init-file-path)])
      (cond
       [(not path) "There is no init file path (no HOME or XDG_CONFIG_HOME)."]
       [(not (file-exists? path)) (format "There is no init file at ~a yet." path)]
       [else
        (load path (lambda (x) (eval x (quad-environment))))
        (format "Loaded ~a." path)])))

  (define (tool-context)
    (let* ([b (current-buffer)])
      (string-join
       (append
        (list (format "quad ~a (~a)" quad-version (scheme-version))
              (format "init file: ~a~a" (init-file-path)
                      (if (and (init-file-path) (file-exists? (init-file-path))) "" " (does not exist yet)"))
              (format "codex directory: ~a" (codex-directory))
              (format "buffers: ~a" (string-join (map buffer-name (buffers)) ", ")))
        (if b
            (list (format "current buffer: ~a, mode ~a, file ~a" (buffer-name b)
                          (major-mode-name (buffer-major-mode b)) (or (buffer-path b) "none"))
                  (format "selections: ~s" (map (lambda (t) (clip t 200)) (sels-texts b))))
            '()))
       "\n")))

  (define (eval-tool args)
    (let* ([out (open-output-string)]
           [v (parameterize ([current-output-port out]) (eval-string (json-ref args 'code)))]
           [printed (get-output-string out)])
      (string-append (if (string=? printed "") "" (string-append "output:\n" printed "\n"))
                     (if (eq? v (void)) "value: (void)" (format "value: ~s" v)))))

  ;; ---------------------------------------------------------------------------
  ;; What the agent is told

  (define (codex-directory)
    (or (get-var 'codex-directory)
        (let ([init (init-file-path)]) (and init (path-dirname init)))
        (current-directory)))

  (define (codex-instructions)
    (format "You are the assistant built into quad, an Emacs-like editor written in Chez Scheme \
with Ki editor's modal key bindings. The user asks you to change or extend the editor itself: \
commands, key bindings, variables, themes, major modes, hooks, tools.

The user's configuration is the init file ~a, loaded at startup with everything quad exports \
in scope; your working directory, ~a, is its directory. Make every change there (or in files \
the init file loads), keeping what is already in it, so it lasts. Then apply it to the running \
editor, with quad_reload_config or quad_eval, and check that it works with quad_eval. Each \
user message ends with a <quad-context> block describing what they are looking at.

Find quad's API with quad_apropos and quad_describe rather than guessing; quad_keymap lists \
bindings, quad_context the editor's state. The essentials:
- (define-command 'name \"doc\" (lambda () ...)); (define-key keymap \"key\" 'name \"Label\")
- keymaps: normal-keymap, insert-keymap, space-keymap; submenus by (keymap-lookup-target space-keymap \"l\")
- key specs: \"a\", \"A\", \"ctrl+u\", \"alt+k\", \"space\", \"enter\", \"esc\", \"tab\", \"backspace\"
- (define-variable name default \"doc\") (a macro: name unquoted); (set-var! 'name value); (get-var 'name)
- (add-hook! 'before-save-hook (lambda (buffer) ...)); (message \"fmt ~~a\" x)
- buffers and selections: current-buffer, buffer-string, sels-texts, edit-sels!, selection-text, insert-at-cursors!
- themes: (define-theme 'name palette faces), (load-theme! 'name)
- tools of your own for later conversations: (define-codex-tool! \"name\" \"description\" json-schema (lambda (args) \"result\"))
quad's Scheme is Chez Scheme 10 (R6RS). Reply briefly: what you changed, and the keys or \
commands to use it."
            (init-file-path) (codex-directory)))

  (define (with-context text)
    (string-append text "\n\n<quad-context>\n" (tool-context) "\n</quad-context>"))

  ;; ---------------------------------------------------------------------------
  ;; The app server

  (define notification-opt-outs
    '#("turn/moderationMetadata" "account/rateLimits/updated" "account/updated"
       "remoteControl/status/changed" "mcpServer/startupStatus/updated"
       "rawResponseItem/completed" "item/reasoning/textDelta"))

  (define (failed! what)
    (lambda (e)
      (add-entry! 'error (format "~a: ~a" what (jsonrpc-error-message e)) 'error)
      (set! waiting '())
      (set! thread-starting? #f)
      (set! busy? #f)))

  (define (mkdir-p dir)
    (unless (or (string=? dir "") (file-exists? dir))
      (mkdir-p (path-dirname dir))
      (mkdir dir)))

  ;; Run k once there is a conversation: start the app server and a thread
  ;; first, if need be.
  (define (codex-start! k)
    (if thread-id
        (k)
        (begin
          (set! waiting (append waiting (list k)))
          (cond
           [(not rpc)
            (let ([dir (codex-directory)])
              (mkdir-p dir)
              (set! stopping? #f)
              (set! rpc (jsonrpc-start (get-var 'codex-command) dir (get-var 'codex-log)
                                       on-notification on-request on-exit))
              (jsonrpc-request!
               rpc "initialize"
               `((clientInfo . ((name . "quad") (title . "quad") (version . ,quad-version)))
                 (capabilities . ((experimentalApi . #t) (requestAttestation . #f)
                                  (optOutNotificationMethods . ,notification-opt-outs))))
               (lambda (r)
                 (set! initialized? #t)
                 (jsonrpc-notify! rpc "initialized" #f)
                 (start-thread!))
               (failed! "Codex would not start")))]
           [initialized? (start-thread!)]))))

  (define (start-thread!)
    (unless thread-starting?
      (set! thread-starting? #t)
      (jsonrpc-request!
       rpc "thread/start"
       `((cwd . ,(codex-directory))
         (approvalPolicy . ,(get-var 'codex-approval-policy))
         (sandbox . ,(get-var 'codex-sandbox))
         ,@(if (get-var 'codex-model) `((model . ,(get-var 'codex-model))) '())
         (developerInstructions . ,(codex-instructions))
         (dynamicTools . ,(list->vector (map tool-spec tools)))
         (ephemeral . #t))
       (lambda (r)
         (set! thread-starting? #f)
         (set! thread-id (json-ref r 'thread 'id))
         (let ([ks waiting])
           (set! waiting '())
           (for-each (lambda (k) (k)) ks)))
       (failed! "Codex would not start a conversation"))))

  ;; Ask the agent for text, as the current client, which is shown the
  ;; popup. While it works, this steers it.
  (define (codex-ask! text)
    (set! turn-client (current-client))
    (when (current-client) (show-popup! codex-popup))
    (add-entry! 'user (string-append "› " text) 'ui.popup.title)
    (let ([input (vector `((type . "text") (text . ,(with-context text)) (text_elements . #())))])
      (set! busy? #t)
      (guard (e [#t (set! rpc #f)
                    (set! busy? #f)
                    (set! waiting '())
                    (add-entry! 'error (format "Codex: ~a" (condition->string e)) 'error)])
        (codex-start!
         (lambda ()
           (if turn-id
               (jsonrpc-request! rpc "turn/steer"
                                 `((threadId . ,thread-id) (input . ,input) (expectedTurnId . ,turn-id))
                                 void
                                 (lambda (e)
                                   (add-entry! 'error (format "Codex did not take that: ~a" (jsonrpc-error-message e))
                                               'error)))
               (jsonrpc-request! rpc "turn/start" `((threadId . ,thread-id) (input . ,input))
                                 (lambda (r) (set! turn-id (json-ref r 'turn 'id)))
                                 (failed! "Codex would not start"))))))))

  (define (codex-interrupt!)
    (if (and rpc thread-id turn-id)
        (jsonrpc-request! rpc "turn/interrupt" `((threadId . ,thread-id) (turnId . ,turn-id)) void)
        (message "Codex is not working on anything")))

  ;; Forget the conversation: the next question starts another.
  (define (codex-new-thread!)
    (set! thread-id #f)
    (set! turn-id #f)
    (set! busy? #f)
    (set! approvals '())
    (set! entries '())
    (hashtable-clear! items))

  (define (codex-stop!)
    (when rpc
      (set! stopping? #t)
      (jsonrpc-stop! rpc)))

  (define (on-exit status)
    (set! rpc #f)
    (set! initialized? #f)
    (set! thread-id #f)
    (set! thread-starting? #f)
    (set! turn-id #f)
    (set! busy? #f)
    (set! approvals '())
    (unless stopping?
      (add-entry! 'error (format "The Codex app server exited (status ~a)." status) 'error)))

  ;; ---------------------------------------------------------------------------
  ;; What the agent does

  (define (ours? params)
    (let ([t (json-ref params 'threadId)]) (or (not t) (equal? t thread-id))))

  (define (on-notification method params)
    (when (ours? params)
      (cond
       [(string=? method "turn/started")
        (set! turn-id (json-ref params 'turn 'id))
        (set! busy? #t)]
       [(string=? method "item/started") (item-started! (json-ref params 'item))]
       [(string=? method "item/agentMessage/delta")
        (let ([e (item-entry! (json-ref params 'itemId) 'agent "" 'ui.popup)])
          (entry-text-set! e (string-append (entry-text e) (or (json-ref params 'delta) ""))))]
       [(string=? method "item/completed") (item-completed! (json-ref params 'item))]
       [(string=? method "turn/completed") (turn-completed! (json-ref params 'turn))]
       [(string=? method "error")
        (add-entry! 'error (format "~a~a" (or (json-ref params 'error 'message) "an error")
                                   (if (json-ref params 'willRetry) " (retrying)" ""))
                    'error)]
       [(string=? method "serverRequest/resolved")
        (let ([id (json-ref params 'requestId)])
          (set! approvals (remp (lambda (a) (equal? (car a) id)) approvals)))]
       [else (void)])))

  (define (changed-files item)
    (let ([changes (or (json-ref item 'changes) '#())])
      (map (lambda (c) (or (json-ref c 'path) "?")) (vector->list changes))))

  (define (item-started! item)
    (let ([id (json-ref item 'id)] [type (json-ref item 'type)])
      (cond
       [(equal? type "agentMessage") (item-entry! id 'agent (or (json-ref item 'text) "") 'ui.popup)]
       [(equal? type "commandExecution")
        (item-entry! id 'command (string-append "$ " (or (json-ref item 'command) "")) 'ui.popup.info)]
       [(equal? type "fileChange")
        (item-entry! id 'files (string-join (map (lambda (f) (string-append "± " f)) (changed-files item)) "\n")
                     'ui.popup.key)]
       [(equal? type "dynamicToolCall")
        (item-entry! id 'tool
                     (format "λ ~a ~a" (json-ref item 'tool)
                             (clip (let ([a (json-ref item 'arguments)])
                                     (cond [(or (not a) (null? a)) ""]
                                           [(and (json-object? a) (= (length a) 1) (string? (cdar a))) (cdar a)]
                                           [else (json->string a)]))
                                   300))
                     'ui.popup.info)]
       [(equal? type "mcpToolCall")
        (item-entry! id 'tool (format "λ ~a/~a" (json-ref item 'server) (json-ref item 'tool)) 'ui.popup.info)]
       [(equal? type "webSearch")
        (item-entry! id 'tool (format "⌕ ~a" (or (json-ref item 'query) "")) 'ui.popup.info)]
       [else (void)])))

  (define (mark! id suffix face)
    (let ([e (and id (hashtable-ref items id #f))])
      (when e
        (entry-text-set! e (string-append (entry-text e) suffix))
        (when face (entry-face-set! e face)))))

  (define (item-completed! item)
    (let ([id (json-ref item 'id)] [type (json-ref item 'type)] [status (json-ref item 'status)])
      (cond
       [(equal? type "agentMessage")
        (entry-text-set! (item-entry! id 'agent "" 'ui.popup) (or (json-ref item 'text) ""))]
       [(equal? type "commandExecution")
        (let ([code (json-ref item 'exitCode)])
          (cond [(equal? status "declined") (mark! id "  (declined)" 'ui.text.dim)]
                [(eqv? code 0) (mark! id "  ✓" #f)]
                [code (mark! id (format "  ✗ exit ~a" code) 'warning)]
                [else (mark! id (format "  (~a)" status) #f)]))]
       [(equal? type "fileChange")
        (if (equal? status "completed")
            (mark! id "  ✓" #f)
            (mark! id (format "  (~a)" status) 'warning))]
       [(equal? type "dynamicToolCall")
        (unless (json-ref item 'success) (mark! id "  ✗" 'warning))]
       [else (void)])))

  (define (turn-completed! turn)
    (set! busy? #f)
    (set! turn-id #f)
    (let ([status (json-ref turn 'status)] [ms (json-ref turn 'durationMs)])
      (cond
       [(equal? status "failed")
        (add-entry! 'error (format "Failed: ~a" (or (json-ref turn 'error 'message) "no reason given")) 'error)]
       [(equal? status "interrupted") (add-entry! 'status "Interrupted." 'ui.text.dim)]
       [else
        (add-entry! 'status (if ms (format "Done in ~,1fs." (/ ms 1000.0)) "Done.") 'ui.text.dim)]))
    (as-asker (lambda () (unless (current-popup) (message "Codex is done: space a p shows what it did")))))

  ;; Requests: tools, and approvals.
  (define (on-request rpc id method params)
    (cond
     [(string=? method "item/tool/call")
      (jsonrpc-reply! rpc id (call-tool (json-ref params 'tool) (or (json-ref params 'arguments) '())))]
     [(string=? method "item/commandExecution/requestApproval")
      (let ([cmd (or (json-ref params 'command) "a command")] [why (json-ref params 'reason)])
        (add-entry! 'approval (format "? run ~a~a" cmd (if why (format " (~a)" why) "")) 'warning)
        (ask-approval! id (string-append "Run " (clip cmd 60) "?")
                       '(("Run it" . "accept") ("Run it, and the like, this session" . "acceptForSession")
                         ("Don't" . "decline") ("Don't, and stop" . "cancel"))))]
     [(string=? method "item/fileChange/requestApproval")
      (let* ([e (hashtable-ref items (or (json-ref params 'itemId) "") #f)]
             [what (if e (entry-text e) "files")])
        (add-entry! 'approval (format "? change ~a" what) 'warning)
        (ask-approval! id "Make these changes?"
                       '(("Change them" . "accept") ("Change files freely this session" . "acceptForSession")
                         ("Don't" . "decline") ("Don't, and stop" . "cancel"))))]
     [(string=? method "mcpServer/elicitation/request")
      (jsonrpc-reply! rpc id '((action . "decline") (content . null) (_meta . null)))]
     [else (jsonrpc-reply-error! rpc id -32601 (format "quad does not handle ~a" method))]))

  (define (ask-approval! id label choices)
    (set! approvals (append approvals (list (list id label choices))))
    (as-asker (lambda () (unless (current-prompt) (codex-approve!)))))

  ;; Answer the oldest waiting approval, in a picker.
  (define (codex-approve!)
    (if (null? approvals)
        (message "Codex is not waiting for an answer")
        (let* ([a (car approvals)] [id (car a)])
          (pick (cadr a) (caddr a)
                (lambda (decision)
                  (set! approvals (remp (lambda (x) (equal? (car x) id)) approvals))
                  (when rpc (jsonrpc-reply! rpc id `((decision . ,decision))))
                  (when (pair? approvals) (codex-approve!)))))))

  ;; ---------------------------------------------------------------------------
  ;; Commands and keys

  (define ai-keymap (make-keymap 'ai "AI"))

  (define (show-transcript!)
    (let ([b (or (find-buffer-named "*codex*")
                 (new-buffer! "*codex*" "" (or (find-major-mode 'markdown) fundamental-mode)))])
      (buffer-replace-all! b (codex-transcript-text))
      (switch-to-buffer! b)))

  (at-load
   (define-codex-tool! "quad_eval"
     "Evaluate Chez Scheme code in the running editor, with everything quad exports in scope, as the user who asked. Returns what it printed and the last form's value, written. Definitions persist until quad exits."
     (object-schema '(code "One or more Scheme forms"))
     eval-tool)
   (define-codex-tool! "quad_describe"
     "Describe a name in quad: the command (its documentation and keys), the variable (its value and documentation), the procedure or value (which library exports it)."
     (object-schema '(name "A command, variable or procedure name, as \"select-line\""))
     (lambda (args) (tool-describe (json-ref args 'name))))
   (define-codex-tool! "quad_apropos"
     "List quad's commands, variables and exported procedures whose names contain a pattern."
     (object-schema '(pattern "A substring, as \"buffer\" or \"theme\""))
     (lambda (args) (tool-apropos (json-ref args 'pattern))))
   (define-codex-tool! "quad_keymap"
     "List a keymap's bindings: a root (normal, insert, prompt, global, space) and keys into it, as \"normal\", \"space\" or \"normal space l\"."
     (object-schema '(keymap "A root, then keys"))
     (lambda (args) (describe-keymap (json-ref args 'keymap))))
   (define-codex-tool! "quad_reload_config"
     "Load the init file into the running editor again, applying the changes made to it. Fails with the error if it does not load."
     '((type . "object") (properties) (additionalProperties . #f))
     (lambda (args) (reload-config)))
   (define-codex-tool! "quad_context"
     "Describe the editor's state: version, init file, buffers, the user's current buffer and selections."
     '((type . "object") (properties) (additionalProperties . #f))
     (lambda (args) (tool-context)))

   (define-command 'codex-ask "Ask Codex to change or extend the editor (or steer it while it works)"
     (lambda ()
       (read-string-dialog (if busy? "Steer Codex" "Ask Codex")
                           (if busy?
                               "What should it do instead, or as well?"
                               "Describe a change to the editor: a command, a key, a setting...")
                           (lambda (s) (unless (string=? (string-trim s) "") (codex-ask! s))))))
   (define-command 'codex-popup "Show or hide what Codex is doing"
     (lambda () (if (current-popup) (hide-popup!) (show-popup! codex-popup))))
   (define-command 'codex-approve "Answer Codex's waiting approval" codex-approve!)
   (define-command 'codex-interrupt "Interrupt Codex" codex-interrupt!)
   (define-command 'codex-transcript "Show the conversation with Codex in a buffer" show-transcript!)
   (define-command 'codex-new-thread "Start a new conversation with Codex"
     (lambda () (codex-new-thread!) (message "The next question starts a new conversation")))
   (define-command 'codex-stop "Stop Codex's app server"
     (lambda () (if rpc (begin (codex-stop!) (message "Stopped Codex")) (message "Codex is not running"))))

   (define-key ai-keymap "a" 'codex-ask "Ask")
   (define-key ai-keymap "p" 'codex-popup "Popup")
   (define-key ai-keymap "y" 'codex-approve "Approve")
   (define-key ai-keymap "i" 'codex-interrupt "Interrupt")
   (define-key ai-keymap "t" 'codex-transcript "Transcript")
   (define-key ai-keymap "n" 'codex-new-thread "New Conversation")
   (define-key ai-keymap "s" 'codex-stop "Stop Server")
   (define-key space-keymap "a" ai-keymap "AI")

   (define-status-segment! 'right
     (lambda (v)
       (cond [(pair? approvals) (cons " codex: approve? " 'ui.statusline.insert)]
             [busy? (cons " codex ⋯ " 'ui.statusline.normal)]
             [else #f])))

   (add-hook! 'kill-editor-hook codex-stop!)))
