;; jsonrpc.sls -- JSON-RPC 2.0 with a subprocess, a message per line
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Programs the editor works with as peers -- Codex's app server, MCP
;; servers on stdio -- speak JSON-RPC 2.0 on their standard input and
;; output, one JSON message per line. The process is the Rust half's
;; (quad native) spawn-process; its output's descriptor joins the editor's
;; event loop (watch-fd!), so messages are handled between keys, as the
;; clients' are.
;;
;;   (define rpc (jsonrpc-start '("server" "--stdio") #f #f
;;                              (lambda (method params) ...)       ; notifications
;;                              (lambda (rpc id method params) ...) ; requests: answer with
;;                              (lambda (status) ...)))            ;   jsonrpc-reply!
;;   (jsonrpc-request! rpc "initialize" '((name . "quad"))
;;                     (lambda (result) ...))
(library (quad jsonrpc)
  (export jsonrpc? jsonrpc-start jsonrpc-request! jsonrpc-notify! jsonrpc-reply!
          jsonrpc-reply-error! jsonrpc-stop! jsonrpc-running? jsonrpc-process
          jsonrpc-error-message)
  (import (chezscheme) (quad json) (quad kernel) (quad native) (quad server))

  (define-record-type jsonrpc
    (fields process (mutable source) (mutable next-id) pending
            on-notification on-request on-exit (mutable partial)))

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
  ;; status) once the process's output ends.
  (define (jsonrpc-start argv cwd stderr on-notification on-request on-exit)
    (let* ([proc (spawn-process argv cwd stderr)]
           [rpc (make-jsonrpc proc #f 1 (make-eqv-hashtable)
                              on-notification on-request on-exit #vu8())])
      (jsonrpc-source-set! rpc (watch-fd! (process-output-fd proc) (lambda () (readable! rpc))))
      rpc))

  (define (jsonrpc-running? rpc) (and (jsonrpc-source rpc) #t))

  (define (send! rpc msg)
    (unless (jsonrpc-running? rpc) (errorf 'jsonrpc "the server has exited"))
    (let ([bv (string->utf8 (string-append (json->string (cons '(jsonrpc . "2.0") msg)) "\n"))]
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

  (define read-buffer (make-bytevector 65536))

  (define (readable! rpc)
    (let ([n (kernel-read (process-output-fd (jsonrpc-process rpc)) read-buffer
                          (bytevector-length read-buffer) 0)])
      (cond
       [(= n -1)
        ;; The end: reap it.
        (process-stop! (jsonrpc-process rpc) 1000)
        (exited! rpc)]
       [(> n 0)
        (let* ([data (bytevector-append (jsonrpc-partial rpc) (subbytevector read-buffer 0 n))]
               [lines (let loop ([start 0])
                        (let ([nl (bytevector-index data 10 start)])
                          (if nl
                              (cons (subbytevector data start nl) (loop (+ nl 1)))
                              (begin
                                (jsonrpc-partial-set! rpc (subbytevector data start (bytevector-length data)))
                                '()))))])
          ;; Every message is handled, even after one fails; the first
          ;; failure is then raised.
          (let ([failure #f])
            (for-each
             (lambda (line)
               (unless (zero? (bytevector-length line))
                 (guard (e [#t (unless failure (set! failure e))])
                   (dispatch! rpc (json-read-string (utf8->string line))))))
             lines)
            (when failure (raise failure))))])))

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

  (define (bytevector-index bv byte start)
    (let ([n (bytevector-length bv)])
      (let loop ([i start])
        (cond [(= i n) #f]
              [(= (bytevector-u8-ref bv i) byte) i]
              [else (loop (+ i 1))]))))

  (define (subbytevector bv start end)
    (let ([out (make-bytevector (- end start))])
      (bytevector-copy! bv start out 0 (- end start))
      out))

  (define (bytevector-append a b)
    (if (zero? (bytevector-length a))
        b
        (let ([out (make-bytevector (+ (bytevector-length a) (bytevector-length b)))])
          (bytevector-copy! a 0 out 0 (bytevector-length a))
          (bytevector-copy! b 0 out (bytevector-length a) (bytevector-length b))
          out))))
