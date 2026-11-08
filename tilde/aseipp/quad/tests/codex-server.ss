;; codex-server.ss -- a stand-in for Codex's app server, for codex.ss
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad --batch runs it as the app server: it reads JSON-RPC from standard
;; input and answers as `codex app-server` does (the order of messages is
;; the real server's). Its one turn does what an agent changing the editor
;; would: it streams a message, calls quad's tools, writes the init file
;; and reloads it, and asks to run a command. Then it asks the user what
;; the agent and MCP servers can ask: a question, a form, a link and more
;; permissions. The turn's last message holds, as JSON after "RESULTS ",
;; what quad answered.

(define (send! v)
  (display (json->string v))
  (newline)
  (flush-output-port (current-output-port)))

(define (next)
  (let ([line (get-line (current-input-port))])
    (if (eof-object? line) (exit 0) (json-read-string line))))

(define thread "thread-1")
(define turn "turn-1")
(define cwd #f)
(define tools '())
(define instructions "")
(define config '())

(define (reply id result) (send! `((id . ,id) (result . ,result))))
(define (notify method params) (send! `((method . ,method) (params . ((threadId . ,thread) ,@params)))))

;; Ask quad, and wait for its answer.
(define (ask id method params)
  (send! `((id . ,id) (method . ,method) (params . ((threadId . ,thread) (turnId . ,turn) ,@params))))
  (let wait ()
    (let ([m (next)])
      (if (and (equal? (json-ref m 'id) id) (not (json-ref m 'method)))
          (begin (notify "serverRequest/resolved" `((requestId . ,id)))
                 (json-ref m 'result))
          (wait)))))

(define (call-tool id name args)
  (let ([r (ask id "item/tool/call" `((callId . ,(format "call-~a" id)) (namespace . null)
                                      (tool . ,name) (arguments . ,args)))])
    `((ok . ,(json-ref r 'success)) (text . ,(json-ref r 'contentItems 0 'text)))))

(define (run-turn! id input)
  (reply id `((turn . ((id . ,turn) (status . "inProgress") (items . #())))))
  (notify "turn/started" `((turn . ((id . ,turn) (status . "inProgress")))))
  (notify "item/started" '((item . ((type . "agentMessage") (id . "m1") (text . "")))))
  (notify "item/agentMessage/delta" '((itemId . "m1") (delta . "Looking")))
  (notify "item/agentMessage/delta" '((itemId . "m1") (delta . " around.")))
  (notify "item/started" '((item . ((type . "dynamicToolCall") (id . "call-100") (tool . "quad_eval")
                                    (arguments . ((code . "(+ 1 2)")))))))
  (let* ([eval (call-tool 100 "quad_eval" '((code . "(display \"hi\") (+ 1 2)")))]
         [fail (call-tool 101 "quad_eval" '((code . "(car '())")))]
         [describe (call-tool 102 "quad_describe" '((name . "escape")))]
         [keymap (call-tool 103 "quad_keymap" '((keymap . "normal space a")))]
         [missing (call-tool 104 "no_such_tool" '())]
         [_ (with-output-to-file (string-append cwd "/init.ss")
              (lambda ()
                (write '(define-command 'from-codex "Added by the agent" (lambda () (message "hi from codex")))))
              'replace)]
         [reload (call-tool 105 "quad_reload_config" '())]
         [context (call-tool 106 "quad_context" '())])
    (notify "item/started" '((item . ((type . "commandExecution") (id . "c1") (command . "make check")))))
    (let ([decision (json-ref (ask 107 "item/commandExecution/requestApproval"
                                   '((itemId . "c1") (command . "make check") (reason . "to test")))
                              'decision)])
      (notify "item/completed" '((item . ((type . "commandExecution") (id . "c1") (command . "make check")
                                          (status . "completed") (exitCode . 0)))))
      (let* ([question (ask 108 "item/tool/requestUserInput"
                            '((itemId . "q1") (isBlocking . #t) (autoResolutionMs . null)
                              (questions . #(((id . "color") (header . "Color") (question . "Which color do you prefer?")
                                              (isOther . #t) (isSecret . #f)
                                              (options . #(((label . "Red") (description . "Choose red."))
                                                           ((label . "Blue") (description . "Choose blue.")))))
                                             ((id . "token") (header . "Token") (question . "Your token?")
                                              (isOther . #f) (isSecret . #t) (options . null))))))]
             [form (ask 109 "mcpServer/elicitation/request"
                        '((serverName . "tracker") (mode . "form") (_meta . null) (message . "File an issue")
                          (requestedSchema
                           . ((type . "object")
                              (properties . ((title . ((type . "string") (title . "Title")))
                                             (severity . ((type . "string") (oneOf . #(((const . "lo") (title . "Low"))
                                                                                      ((const . "hi") (title . "High"))))))
                                             (count . ((type . "integer") (title . "Count")))
                                             (urgent . ((type . "boolean") (default . #f)))
                                             (tags . ((type . "array") (items . ((type . "string") (enum . #("a" "b" "c"))))))
                                             (note . ((type . "string") (description . "Anything else")))))
                              (required . #("title" "severity" "count"))))))]
             [link (ask 110 "mcpServer/elicitation/request"
                        '((serverName . "tracker") (mode . "url") (_meta . null) (message . "Sign in")
                          (url . "https://example.com/login") (elicitationId . "e1")))]
             [permissions (ask 111 "item/permissions/requestApproval"
                               '((itemId . "p1") (environmentId . null) (startedAtMs . 0) (cwd . "/")
                                 (reason . "to fetch a package")
                                 (permissions . ((network . ((enabled . #t))) (fileSystem . null)))))]
             ;; One the server stops waiting for before quad answers.
             [_ (begin (send! `((id . 112) (method . "item/commandExecution/requestApproval")
                                (params . ((threadId . ,thread) (turnId . ,turn) (itemId . "c2") (command . "true")))))
                       (notify "serverRequest/resolved" '((requestId . 112))))]
             [results `((input . ,input) (cwd . ,cwd) (tools . ,(list->vector tools))
                        (questions-on . ,(json-ref config 'features.default_mode_request_user_input))
                        (question . ,question) (form . ,form) (link . ,link) (permissions . ,permissions)
                       (instructions . ,(and (string-contains instructions cwd) #t))
                       (eval . ,eval) (fail . ,fail) (describe . ,describe) (keymap . ,keymap)
                       (missing . ,missing) (reload . ,reload) (context . ,context)
                       (decision . ,decision))])
        (notify "item/completed" `((item . ((type . "agentMessage") (id . "m1")
                                            (text . ,(string-append "RESULTS " (json->string results)))))))
        (notify "turn/completed" `((turn . ((id . ,turn) (status . "completed") (durationMs . 1500)))))))))

(let loop ()
  (let* ([m (next)] [id (json-ref m 'id)] [method (json-ref m 'method)] [params (json-ref m 'params)])
    (cond
     [(equal? method "initialize")
      (reply id `((userAgent . "fake/0") (codexHome . "/nonexistent") (platformFamily . "unix")
                  (platformOs . "linux")))]
     [(equal? method "thread/start")
      (set! cwd (json-ref params 'cwd))
      (set! instructions (json-ref params 'developerInstructions))
      (set! config (or (json-ref params 'config) '()))
      (set! tools (map (lambda (t) (json-ref t 'name)) (vector->list (json-ref params 'dynamicTools))))
      (reply id `((thread . ((id . ,thread) (cwd . ,cwd)))))
      (notify "thread/started" `((thread . ((id . ,thread)))))]
     [(equal? method "turn/start") (run-turn! id (json-ref params 'input 0 'text))]
     [id (send! `((id . ,id) (error . ((code . -32601) (message . ,(format "unknown method ~a" method))))))]
     [else (void)])
    (loop)))
