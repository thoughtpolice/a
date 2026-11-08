;; server.sls -- the editor as a server: its clients, and the event loop
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The server waits on a set of sources, each a file descriptor with what to
;; do when it is readable: the terminal of a client in this process, a
;; listening socket, the connection of each client elsewhere. Messages from
;; clients (protocol.sls) go to client-receive!; after each round, every
;; client is drawn (display.sls) and sent what changed.
;;
;; A transport is anything that delivers a byte stream on a descriptor:
;; serve-stream! serves a client over one, speaking framed messages. Unix
;; sockets are built in (server-listen!); others, like Iroh's QUIC streams,
;; hand the server a descriptor per stream.
(library (quad server)
  (export make-source source? add-source! remove-source! sources
          server-connect! client-receive! server-render! server-run!
          serve-stream! server-listen! server-unlisten! default-socket-path
          frame-sender)
  (import (chezscheme) (quad util) (quad kernel) (quad event) (quad buffer)
          (quad editor) (quad commands) (quad display) (quad protocol))

  ;; ---------------------------------------------------------------------------
  ;; Sources

  ;; fd: what to poll. readable: called when fd is readable. timeout: a
  ;; thunk giving the milliseconds until on-timeout wants calling, or -1.
  ;; tick: called every round, after waiting.
  (define-record-type source (fields fd readable timeout on-timeout tick))

  (define the-sources '())
  (define (sources) the-sources)
  (define (add-source! s) (set! the-sources (append the-sources (list s))))
  (define (remove-source! s) (set! the-sources (remq s the-sources)))

  ;; ---------------------------------------------------------------------------
  ;; Clients

  ;; Connect a client: name, its screen size, its capabilities (strings, see
  ;; docs/design.md), and how to send it messages and close it.
  (define (server-connect! name rows cols capabilities send close)
    (add-client! name (make-connection send close) rows cols capabilities))

  (define (stringify v) (with-output-to-string (lambda () (write v))))

  ;; Handle a message from client c.
  (define (client-receive! c msg)
    (let ([ev (message->event msg)])
      (if ev
          (with-client c (lambda () (handle-event ev)))
          (case (string->symbol (car msg))
            [(resize)
             (client-rows-set! c (cadr msg))
             (client-cols-set! c (caddr msg))
             (invalidate-client! c)]
            [(redraw) (invalidate-client! c)]
            [(open)
             (with-client c
               (lambda ()
                 (run-command
                  (lambda ()
                    (switch-to-buffer! (open-file! (cadr msg)))
                    (when (and (pair? (cddr msg)) (caddr msg)) (goto-line! (caddr msg)))))))]
            [(eval)
             (let ([id (cadr msg)])
               (with-client c
                 (lambda ()
                   (client-send!
                    c (guard (e [#t (list "result" id #f (condition->string e))])
                        (list "result" id #t (stringify (eval-string (caddr msg)))))))))]
            [(detach) (with-client c (lambda () (client-quit! c)))]
            [(hello) (void)]
            [else (with-client c (lambda () (message-error "Unknown message ~a" (car msg))))])))
    (for-each (lambda (c) (client-dirty?-set! c #t)) (clients)))

  ;; Draw every client.
  (define (server-render!)
    (for-each render-client! (clients)))

  ;; ---------------------------------------------------------------------------
  ;; The loop

  (define (server-run!)
    (let loop ()
      (when (editor-running?)
        (server-render!)
        (let* ([timeouts (append (map (lambda (s) ((source-timeout s))) the-sources)
                                 (map idle-timeout (clients)))]
               [waits (filter (lambda (t) (>= t 0)) timeouts)]
               [timeout (if (null? waits) -1 (apply min waits))]
               [ready (kernel-poll (map source-fd the-sources) timeout)])
          (for-each
           (lambda (s)
             (when (and (memv (source-fd s) ready) (memq s the-sources))
               (guarded (source-readable s))))
           the-sources)
          (when (null? ready)
            (for-each (lambda (s)
                        (let ([t ((source-timeout s))])
                          (when (and (>= t 0) (<= t timeout)) (guarded (source-on-timeout s)))))
                      the-sources))
          (for-each (lambda (s) (guarded (source-tick s))) the-sources))
        (loop))))

  (define (guarded thunk)
    (guard (e [#t (message-error "~a" (condition->string e))])
      (thunk)))

  ;; ---------------------------------------------------------------------------
  ;; Streams: clients over a byte-stream descriptor, speaking frames

  (define (frame-sender fd)
    (lambda (msg)
      (let ([bv (encode-frame msg)])
        (kernel-write fd bv (bytevector-length bv)))))

  (define read-buffer (make-bytevector 65536))

  ;; Serve a client on descriptor fd: its first message must be "hello".
  ;; on-close runs when it goes.
  (define serve-stream!
    (case-lambda
     [(fd) (serve-stream! fd void)]
     [(fd on-close)
      (let* ([reader (make-frame-reader)]
             [client #f]
             [src #f]
             [close! (lambda ()
                       (when (memq src the-sources)
                         (remove-source! src)
                         (kernel-close fd)
                         (on-close)))])
        (set! src
              (make-source
               fd
               (lambda ()
                 (let ([n (kernel-read fd read-buffer (bytevector-length read-buffer) 0)])
                   (cond
                    [(= n -1)
                     ;; Gone: the client disconnected.
                     (if client (remove-client! client) (close!))]
                    [(> n 0)
                     (for-each
                      (lambda (msg)
                        (cond
                         [client (client-receive! client msg)]
                         [(and (pair? msg) (equal? (car msg) "hello"))
                          ;; ("hello" version name rows cols capabilities)
                          (let-values ([(version name rows cols caps) (apply values (cdr msg))])
                            (set! client (server-connect! name rows cols caps (frame-sender fd) close!))
                            (when (> version protocol-version)
                              (with-client client (lambda () (message-error "Client speaks protocol ~a; this server ~a" version protocol-version)))))]
                         [else (close!)]))
                      (reader read-buffer n))])))
               (lambda () -1) void void))
        (add-source! src)
        src)]))

  ;; ---------------------------------------------------------------------------
  ;; Unix sockets

  ;; $QUAD_SOCKET, else quad.sock in $XDG_RUNTIME_DIR/quad, else in
  ;; /tmp/quad-$USER.
  (define (default-socket-path)
    (or (getenv "QUAD_SOCKET")
        (path-join (if (getenv "XDG_RUNTIME_DIR")
                       (path-join (getenv "XDG_RUNTIME_DIR") "quad")
                       (format "/tmp/quad-~a" (or (getenv "USER") "user")))
                   "quad.sock")))

  (define listening '())

  ;; Accept clients on a Unix socket at path. A socket left by a server
  ;; that is gone is replaced; a live one is an error.
  (define (server-listen! path)
    (let ([dir (path-dirname path)])
      (unless (file-exists? dir) (mkdir dir #o700)))
    (when (file-exists? path)
      (let ([fd (kernel-unix-connect path)])
        (if (>= fd 0)
            (begin (kernel-close fd) (errorf 'server-listen! "a server is already listening at ~a" path))
            (delete-file path))))
    (let ([fd (kernel-unix-listen path)])
      (when (< fd 0) (errorf 'server-listen! "cannot listen at ~a" path))
      (set! listening (cons (cons path fd) listening))
      (add-source! (make-source fd
                                (lambda ()
                                  (let ([c (kernel-accept fd)])
                                    (when (>= c 0) (serve-stream! c))))
                                (lambda () -1) void void))
      (add-hook! 'kill-editor-hook (lambda () (server-unlisten! path)))
      path))

  (define (server-unlisten! path)
    (let ([e (assoc path listening)])
      (when e
        (set! listening (remq e listening))
        (for-each (lambda (s) (when (= (source-fd s) (cdr e)) (remove-source! s))) the-sources)
        (kernel-close (cdr e))
        (when (file-exists? path) (delete-file path))))))
