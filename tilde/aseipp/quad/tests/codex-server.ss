;; codex-server.ss -- a stand-in for Codex's app server, for codex.ss
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad --batch runs it as the app server: it reads JSON-RPC from standard
;; input and answers as `codex app-server` does (the order of messages is
;; the real server's). Its one turn does what an agent changing the editor
;; would: it streams a message, calls quad's tools, writes the init file
;; and reloads it, and asks to run a command. The turn's last message holds,
;; as JSON after "RESULTS ", what quad answered.

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

(define (reply id result) (send! `((id . ,id) (result . ,result))))
(define (notify method params) (send! `((method . ,method) (params . ((threadId . ,thread) ,@params)))))

;; Ask quad, and wait for its answer.
(define (ask id method params)
  (send! `((id . ,id) (method . ,method) (params . ((threadId . ,thread) (turnId . ,turn) ,@params))))
  (let wait ()
    (let ([m (next)])
      (if (and (equal? (json-ref m 'id) id) (not (json-ref m 'method)))
          (json-ref m 'result)
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
      (let ([results `((input . ,input) (cwd . ,cwd) (tools . ,(list->vector tools))
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
      (set! tools (map (lambda (t) (json-ref t 'name)) (vector->list (json-ref params 'dynamicTools))))
      (reply id `((thread . ((id . ,thread) (cwd . ,cwd)))))
      (notify "thread/started" `((thread . ((id . ,thread)))))]
     [(equal? method "turn/start") (run-turn! id (json-ref params 'input 0 'text))]
     [id (send! `((id . ,id) (error . ((code . -32601) (message . ,(format "unknown method ~a" method))))))]
     [else (void)])
    (loop)))
