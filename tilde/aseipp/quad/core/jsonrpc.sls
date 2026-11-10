;; jsonrpc.sls -- JSON-RPC 2.0 with a subprocess
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Programs the editor works with as peers -- Codex's app server, MCP
;; servers and language servers on stdio -- speak JSON-RPC 2.0 on their
;; standard input and output: one JSON message per line (framing 'lines),
;; or each after a Content-Length header, as the Language Server Protocol
;; has it (framing 'headers). The process is the Rust half's
;; (quad native) spawn-process; its output's descriptor joins the editor's
;; event loop (watch-fd!), so messages are handled between keys, as the
;; clients' are.
;;
;;   (define rpc (jsonrpc-start '("server" "--stdio") #f #f
;;                              (lambda (method params) ...)       ; notifications
;;                              (lambda (rpc id method params) ...) ; requests: answer with
;;                              (lambda (status) ...)              ;   jsonrpc-reply!
;;                              'lines))                           ; or 'headers
;;   (jsonrpc-request! rpc "initialize" '((name . "quad"))
;;                     (lambda (result) ...))
(library (quad jsonrpc)
  (export jsonrpc? jsonrpc-start jsonrpc-request! jsonrpc-notify! jsonrpc-reply!
          jsonrpc-reply-error! jsonrpc-stop! jsonrpc-running? jsonrpc-process
          jsonrpc-error-message)
  (import (chezscheme) (quad util) (quad json) (quad kernel) (quad native) (quad server))

  (define-record-type jsonrpc
    (fields process (mutable source) (mutable next-id) pending
            on-notification on-request on-exit (mutable partial) framing))

  ;; A JSON-RPC error object's message, or a description of it.
  (define (jsonrpc-error-message e)
    (or (and (json-object? e) (json-ref e 'message)) (json->string e)))

  (define (default-on-error method)
    (lambda (e) (errorf 'jsonrpc "~a: ~a" method (jsonrpc-error-message e))))

  ;; Start argv (a list of strings) in directory cwd (#f: the editor's),
  ;; its standard error appended to the file stderr (#f: discarded).
  ;; (on-notification method params) for each notification;
  ;; (on-request rpc id method params) for each request, which is answered
  ;; with jsonrpc-reply! or jsonrpc-reply-error!, then or later; (on-exit
  ;; status) once the process's output ends. framing is 'lines (the
  ;; default) or 'headers.
  (define jsonrpc-start
    (case-lambda
     [(argv cwd stderr on-notification on-request on-exit)
      (jsonrpc-start argv cwd stderr on-notification on-request on-exit 'lines)]
     [(argv cwd stderr on-notification on-request on-exit framing)
      (unless (memq framing '(lines headers)) (errorf 'jsonrpc-start "unknown framing ~s" framing))
      (let* ([proc (spawn-process argv cwd stderr)]
             [rpc (make-jsonrpc proc #f 1 (make-eqv-hashtable)
                                on-notification on-request on-exit
                                (make-incoming (make-bytevector 4096) 0 0) framing)])
        (jsonrpc-source-set! rpc (watch-fd! (process-output-fd proc) (lambda () (readable! rpc))))
        rpc)]))

  (define (jsonrpc-running? rpc) (and (jsonrpc-source rpc) #t))

  (define (send! rpc msg)
    (unless (jsonrpc-running? rpc) (errorf 'jsonrpc "the server has exited"))
    (let* ([body (string->utf8 (json->string (cons '(jsonrpc . "2.0") msg)))]
           [bv (if (eq? (jsonrpc-framing rpc) 'headers)
                   (bytevector-append (string->utf8 (format "Content-Length: ~a\r\n\r\n" (bytevector-length body)))
                                      body)
                   (bytevector-append body #vu8(10)))]
           [fd (process-input-fd (jsonrpc-process rpc))])
      (when (or (< fd 0) (< (kernel-write fd bv (bytevector-length bv)) 0))
        (errorf 'jsonrpc "cannot write to the server"))))

  ;; Call method with params (a JSON value; #f for none), then (on-result
  ;; result), or (on-error error-object): by default, an error.
  (define jsonrpc-request!
    (case-lambda
     [(rpc method params on-result)
      (jsonrpc-request! rpc method params on-result (default-on-error method))]
     [(rpc method params on-result on-error)
      (let ([id (jsonrpc-next-id rpc)])
        (jsonrpc-next-id-set! rpc (+ id 1))
        (hashtable-set! (jsonrpc-pending rpc) id (cons on-result on-error))
        (send! rpc `((id . ,id) (method . ,method) ,@(if params `((params . ,params)) '()))))]))

  (define (jsonrpc-notify! rpc method params)
    (send! rpc `((method . ,method) ,@(if params `((params . ,params)) '()))))

  (define (jsonrpc-reply! rpc id result)
    (send! rpc `((id . ,id) (result . ,result))))

  (define (jsonrpc-reply-error! rpc id code message)
    (send! rpc `((id . ,id) (error . ((code . ,code) (message . ,message))))))

  ;; Stop the server: close its input, wait up to grace-ms for it to exit,
  ;; then kill it. on-exit runs.
  (define jsonrpc-stop!
    (case-lambda
     [(rpc) (jsonrpc-stop! rpc 1000)]
     [(rpc grace-ms)
      (when (jsonrpc-running? rpc)
        (process-stop! (jsonrpc-process rpc) grace-ms)
        (exited! rpc))]))

  (define (readable! rpc)
    (let ([got (kernel-read-some (process-output-fd (jsonrpc-process rpc)) 0)])
      (cond
       [(not got)
        ;; The end: reap it.
        (process-stop! (jsonrpc-process rpc) 1000)
        (exited! rpc)]
       [(> (bytevector-length got) 0)
        (let* ([in (jsonrpc-partial rpc)]
               [_ (incoming-add! in got)]
               [messages (if (eq? (jsonrpc-framing rpc) 'headers)
                             (split-framed! in)
                             (split-lines! in))])
          ;; Every message is handled, even after one fails; the first
          ;; failure is then raised.
          (let ([failure #f])
            (for-each
             (lambda (m)
               (unless (zero? (bytevector-length m))
                 (guard (e [#t (unless failure (set! failure e))])
                   (dispatch! rpc (json-read-string (utf8->string m))))))
             messages)
            (when failure (raise failure))))])))

  ;; What has come and is not a whole message yet: buf's first len bytes,
  ;; the first `scanned` of which hold no end of one. A message coming in
  ;; many reads is copied and searched once, not once a read.
  (define-record-type incoming (fields (mutable buf) (mutable len) (mutable scanned)))

  (define (incoming-add! in got)
    (let ([len (incoming-len in)] [n (bytevector-length got)])
      (when (> (+ len n) (bytevector-length (incoming-buf in)))
        (let ([new (make-bytevector (max (* 2 (bytevector-length (incoming-buf in))) (+ len n)))])
          (bytevector-copy! (incoming-buf in) 0 new 0 len)
          (incoming-buf-set! in new)))
      (bytevector-copy! got 0 (incoming-buf in) len n)
      (incoming-len-set! in (+ len n))))

  ;; Messages were taken up to start, and what is from there on was looked
  ;; through up to scanned: it moves to the front, to wait for more.
  (define (incoming-keep! in start scanned)
    (let ([buf (incoming-buf in)] [rest (- (incoming-len in) start)])
      (unless (zero? start)
        (bytevector-copy! buf start buf 0 rest))
      (incoming-len-set! in rest)
      (incoming-scanned-set! in (max 0 (- scanned start)))))

  ;; The whole messages that have come; what follows the last waits for
  ;; more. Each is copied out before the rest moves (incoming-keep!).
  (define (split-lines! in)
    (let ([buf (incoming-buf in)] [len (incoming-len in)])
      (let loop ([start 0] [from (incoming-scanned in)])
        (let ([nl (bytevector-index buf 10 from len)])
          (if nl
              (let ([m (subbytevector buf start nl)]) (cons m (loop (+ nl 1) (+ nl 1))))
              (begin (incoming-keep! in start len) '()))))))

  ;; Headers, a blank line, then Content-Length bytes of message.
  (define (split-framed! in)
    (let ([buf (incoming-buf in)] [len (incoming-len in)])
      (let loop ([start 0] [from (incoming-scanned in)])
        (let* ([end (bytevector-search buf #vu8(13 10 13 10) (max start from) len)]
               [length (and end (content-length (utf8->string (subbytevector buf start end))))])
          (cond
           [(and end (not length))
            (errorf 'jsonrpc "a message without a Content-Length: ~s"
                    (utf8->string (subbytevector buf start end)))]
           [(and end (<= (+ end 4 length) len))
            (let ([m (subbytevector buf (+ end 4) (+ end 4 length))])
              (cons m (loop (+ end 4 length) (+ end 4 length))))]
           ;; Its headers are whole, its body not yet: they are found again
           ;; (a few bytes) once more comes.
           [end (incoming-keep! in start start) '()]
           ;; No end of headers yet: the last three bytes may begin one.
           [else (incoming-keep! in start (max start (- len 3))) '()])))))

  (define (content-length headers)
    (exists (lambda (line)
              (let ([colon (string-index line #\:)])
                (and colon
                     (string-ci=? (string-trim (substring line 0 colon)) "content-length")
                     (string->number (string-trim (substring line (+ colon 1) (string-length line)))))))
            (string-split headers #\newline)))

  (define (exited! rpc)
    (let ([src (jsonrpc-source rpc)])
      (when src
        (remove-source! src)
        (jsonrpc-source-set! rpc #f)
        (let-values ([(ids handlers) (hashtable-entries (jsonrpc-pending rpc))])
          (hashtable-clear! (jsonrpc-pending rpc))
          (vector-for-each (lambda (h) ((cdr h) '((code . -32000) (message . "the server exited")))) handlers))
        ((jsonrpc-on-exit rpc) (process-status (jsonrpc-process rpc))))))

  (define (dispatch! rpc msg)
    (let ([id (json-ref msg 'id)] [method (json-ref msg 'method)] [params (json-ref msg 'params)])
      (cond
       [(and method id) ((jsonrpc-on-request rpc) rpc id method params)]
       [method ((jsonrpc-on-notification rpc) method params)]
       [(and id (hashtable-ref (jsonrpc-pending rpc) id #f))
        => (lambda (h)
             (hashtable-delete! (jsonrpc-pending rpc) id)
             (let ([err (json-ref msg 'error)])
               (if err ((cdr h) err) ((car h) (let ([e (assq 'result msg)]) (if e (cdr e) 'null))))))]
       [else (void)])))

  ;; ---------------------------------------------------------------------------
  ;; Bytes

  ;; Where byte (or pat) first is in bv from start, before n; or #f.
  (define (bytevector-index bv byte start n)
    (let loop ([i start])
      (cond [(>= i n) #f]
            [(= (bytevector-u8-ref bv i) byte) i]
            [else (loop (+ i 1))])))

  (define (bytevector-search bv pat start n)
    (let ([m (bytevector-length pat)])
      (let loop ([i start])
        (cond [(> (+ i m) n) #f]
              [(let match ([j 0]) (or (= j m) (and (= (bytevector-u8-ref bv (+ i j)) (bytevector-u8-ref pat j))
                                                   (match (+ j 1)))))
               i]
              [else (loop (+ i 1))]))))

  (define (subbytevector bv start end)
    (let ([out (make-bytevector (- end start))])
      (bytevector-copy! bv start out 0 (- end start))
      out))

)
