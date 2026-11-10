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
;; sockets are built in (server-listen!); others, like Iroh's QUIC streams
;; from the kernel's Rust half, hand the server a descriptor per stream.
(library (quad server)
  (export make-source source? add-source! remove-source! sources watch-fd! run-program!
          server-connect! client-receive! server-render! server-run!
          serve-stream! server-listen! server-unlisten! server-listening-paths default-socket-path
          socket-dir-safe? define-pointer-handler!
          make-transport transport? transport-name transport-label transport-target?
          transport-connect transport-connect-later transport-self? transport-listen
          define-transport! transport-for find-transport
          frame-sender)
  (import (chezscheme) (quad util) (quad kernel) (quad event) (quad buffer)
          (quad editor) (quad commands) (quad display) (quad protocol) (quad anim)
          (only (quad native) command-start command-fd command-take!))

  ;; ---------------------------------------------------------------------------
  ;; Sources

  ;; fd: what to poll. readable: called when fd is readable. timeout: a
  ;; thunk giving the milliseconds until on-timeout wants calling, or -1.
  ;; tick: called every round, after waiting.
  (define-record-type source (fields fd readable timeout on-timeout tick))

  ;; Animation's frames (anim.sls): it says when the next is due, and the
  ;; loop draws once it has moved things there.
  (define the-sources (list (make-source -1 void anim-timeout anim-tick! void)))
  (define (sources) the-sources)
  (define (add-source! s) (set! the-sources (append the-sources (list s))))
  (define (remove-source! s) (set! the-sources (remq s the-sources)))

  ;; Call (on-readable) whenever fd is readable, until the source returned
  ;; is removed: how components with threads of their own (the Rust half's
  ;; mailboxes) join the event loop.
  (define (watch-fd! fd on-readable)
    (let ([s (make-source fd on-readable (lambda () -1) void void)])
      (add-source! s)
      s))

  ;; Run argv (searched for in PATH) in directory cwd (#f: the editor's),
  ;; with env's "NAME=value" strings added to its environment and nothing
  ;; to read, on a thread of its own; once it ends, (done status output
  ;; errors) from the loop, status -1000 if it could not start. Returns a
  ;; thunk that forgets it, so that done is not called.
  (define (run-program! argv cwd env done)
    (let* ([r (command-start argv cwd env)] [src #f])
      (set! src (watch-fd! (command-fd r)
                           (lambda ()
                             (let ([got (command-take! r)])
                               (when (pair? got)
                                 (remove-source! src)
                                 (apply done (car got)))))))
      (lambda () (remove-source! src))))

  ;; ---------------------------------------------------------------------------
  ;; Clients

  ;; Connect a client: name, its screen size, its capabilities (strings, see
  ;; docs/design.md), and how to send it messages and close it.
  (define (server-connect! name rows cols capabilities send close)
    (add-client! name (make-connection send close) rows cols capabilities))

  (define (stringify v) (with-output-to-string (lambda () (write v))))

  ;; What extensions make of the pointer: name -> #(hover shape forget).
  ;; (hover c row col mods): the pointer moved to (row, col) on client c's
  ;; screen, with mods held; whether that changed what c shows (a link
  ;; under it underlined, say). (shape c row col): the pointer's shape
  ;; there, or #f to leave it to the others. (forget c): other input came,
  ;; which may move what is under the pointer.
  (define pointer-handlers '())

  (define (define-pointer-handler! name hover shape forget)
    (set! pointer-handlers
          (append (remp (lambda (h) (eq? (car h) name)) pointer-handlers)
                  (list (cons name (vector hover shape forget))))))

  (define (each-pointer-handler f) (for-each (lambda (h) (f (cdr h))) pointer-handlers))

  ;; The pointer's shape over what is at (row, col) on client c's screen:
  ;; an extension's, else text over a buffer's text, the arrow elsewhere.
  (define (pointer-shape c row col)
    (cond
     [(exists (lambda (h) ((vector-ref (cdr h) 1) c row col)) pointer-handlers) => values]
     [(with-client c (lambda () (screen->position row col))) "text"]
     [else "default"]))

  ;; The pointer moved over client c's screen: tell the extensions, and c
  ;; the pointer's shape when that changes. Whether what c shows changed.
  (define (pointer-moved! c ev)
    (let* ([row (mouse-event-row ev)] [col (mouse-event-col ev)]
           [changed? (fold-left (lambda (changed? h)
                                  (or ((vector-ref (cdr h) 0) c row col (mouse-event-mods ev)) changed?))
                                #f pointer-handlers)])
      (when (client-has? c "pointer-shape")
        (let ([shape (pointer-shape c row col)])
          (unless (equal? shape (client-local c 'pointer #f))
            (client-local-set! c 'pointer shape)
            (client-send! c (list "pointer" shape)))))
      changed?))

  ;; Messages from clients, and those of them that changed nothing (a
  ;; pointer moving over the same things): the loop draws only after
  ;; something may have changed.
  (define received 0)
  (define received-quietly 0)

  ;; Handle a message from client c.
  (define (client-receive! c msg)
    (set! received (+ received 1))
    (let ([ev (message->event msg)])
      (if ev
          (if (and (mouse-event? ev) (eq? (mouse-event-kind ev) 'move))
              (unless (pointer-moved! c ev) (set! received-quietly (+ received-quietly 1)))
              (begin
                ;; What is under the pointer may move: until it moves
                ;; again, nothing is under it.
                (each-pointer-handler (lambda (h) ((vector-ref h 2) c)))
                (with-client c (lambda () (handle-event ev)))))
          (case (string->symbol (car msg))
            [(resize)
             (when (and (= (length msg) 3) (screen-size? (cadr msg)) (screen-size? (caddr msg)))
               (client-rows-set! c (cadr msg))
               (client-cols-set! c (caddr msg))
               (invalidate-client! c))]
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
            ;; ("voice" "failed" why): see core/ext/voice.sls.
            [(voice) (run-hooks 'client-voice-hook c (cdr msg))]
            [(user) (when (and (pair? (cdr msg)) (string? (cadr msg)))
                      (set-client-user! c (cadr msg)))]
            [else (with-client c (lambda () (message-error "Unknown message ~a" (car msg))))]))))

  ;; Draw every client. One whose drawing fails is let go, with why in
  ;; *Messages*, rather than the error ending the editor and every other
  ;; client with it.
  (define (server-render!)
    (anim-render-begin!)
    (for-each (lambda (c)
                ;; A client diverted to another editor (client-divert!)
                ;; shows that one's frames, not these: it is drawn whole
                ;; again when it comes back.
                (unless (client-diverted? c)
                  (guard (e [#t (log-message! (format "Letting client ~a go: drawing it failed: ~a"
                                                      (client-name c) (condition->string e)))
                                (remove-client! c)])
                    (render-client! c))))
              (clients)))

  ;; Whether n is a screen's height or width in cells, as a client may say:
  ;; a size that no screen has would make each frame without end.
  (define (screen-size? n) (and (fixnum? n) (<= 1 n 4000)))

  ;; Whether msg is a hello a client may send: ("hello" version name rows
  ;; cols capabilities), capabilities a list of strings.
  (define (valid-hello? msg)
    (and (list? msg) (= (length msg) 6)
         (fixnum? (list-ref msg 1)) (string? (list-ref msg 2))
         (screen-size? (list-ref msg 3)) (screen-size? (list-ref msg 4))
         (list? (list-ref msg 5)) (for-all string? (list-ref msg 5))))

  ;; ---------------------------------------------------------------------------
  ;; The loop

  ;; Each round draws the clients, unless all the last one did was take
  ;; messages that changed nothing; then waits for input or a timeout and
  ;; handles it. A source that is read without a client receiving
  ;; anything (a language server's output, say) or a timeout may have
  ;; changed anything.
  (define draw-next? #t)
  (define (server-run!)
    (let loop ()
      (when (editor-running?)
        (when draw-next? (server-render!))
        (let* ([timeouts (append (map (lambda (s) ((source-timeout s))) the-sources)
                                 (map idle-timeout (clients)))]
               [waits (filter (lambda (t) (>= t 0)) timeouts)]
               [timeout (if (null? waits) -1 (apply min waits))]
               [writes (map outbox-fd (filter (lambda (b) (not (outbox-empty? b))) outboxes))]
               [timeout (if (exists outbox-over? outboxes) 0 timeout)]
               [ready+writable (call-with-values
                                   (lambda () (kernel-poll-rw (map source-fd the-sources) writes timeout))
                                 cons)]
               [ready (car ready+writable)]
               [writable (cdr ready+writable)]
               [timed-out? (and (null? ready) (null? writable))]
               [changed? timed-out?]
               [r0 received] [q0 received-quietly])
          (outboxes-serve! writable)
          ;; Asked to stop (SIGTERM, SIGHUP): as told to quit, with a word
          ;; to each client.
          (when (and (kernel-stop-requested?) (editor-running?))
            (editor-quit!))
          (for-each
           (lambda (s)
             (when (and (memv (source-fd s) ready) (memq s the-sources))
               (let ([before received])
                 (guarded (source-readable s))
                 (when (= received before) (set! changed? #t)))))
           the-sources)
          (when timed-out?
            (for-each (lambda (s)
                        (let ([t ((source-timeout s))])
                          (when (and (>= t 0) (<= t timeout)) (guarded (source-on-timeout s)))))
                      the-sources))
          (for-each (lambda (s) (guarded (source-tick s))) the-sources)
          (set! draw-next? (or changed? (> (- received r0) (- received-quietly q0))))
          (loop)))))

  (define (guarded thunk)
    (guard (e [#t (message-error "~a" (condition->string e))])
      (thunk)))

  ;; ---------------------------------------------------------------------------
  ;; Outboxes: what a client over a stream has yet to take
  ;;
  ;; A client that stops reading (stopped with ^Z, or on a slow link) must
  ;; not stop the editor, as a write that waits for it would: what its
  ;; stream does not take at once waits in its outbox, and is written as
  ;; the stream takes it (the loop waits for that too). A client that falls
  ;; outbox-limit bytes behind is let go.

  (define outbox-limit (* 16 1024 1024))

  ;; pending: the frames being written, as one bytevector, from byte
  ;; `start` (or #f); tail: those after, newest first. bytes: how many are
  ;; waiting. over?: past the limit, it is to be let go (by `drop`), which
  ;; the loop does once its round is done.
  (define-record-type outbox
    (fields fd drop (mutable pending) (mutable start) (mutable tail) (mutable bytes) (mutable over?)))

  ;; Outboxes with something in them.
  (define outboxes '())

  (define (outbox-empty? b) (and (not (outbox-pending b)) (null? (outbox-tail b))))

  ;; Write what fd takes of b's frames, without waiting: those waiting
  ;; together, in one write.
  (define (outbox-flush! b)
    (let loop ()
      (let ([tail (outbox-tail b)])
        (when (and (not (outbox-pending b)) (pair? tail))
          (outbox-pending-set! b (if (null? (cdr tail)) (car tail) (apply bytevector-append (reverse tail))))
          (outbox-tail-set! b '())))
      (let ([bv (outbox-pending b)])
        (when bv
          (let* ([start (outbox-start b)] [n (kernel-write-some (outbox-fd b) bv start)])
            (cond
             ;; The stream failed: reading it says so, and lets the client go.
             [(< n 0) (outbox-pending-set! b #f) (outbox-tail-set! b '()) (outbox-bytes-set! b 0)]
             [else
              (outbox-bytes-set! b (- (outbox-bytes b) n))
              (if (= (+ start n) (bytevector-length bv))
                  (begin (outbox-pending-set! b #f) (outbox-start-set! b 0) (loop))
                  (outbox-start-set! b (+ start n)))]))))))

  ;; The messages of a frame, which its "flush" ends: they wait for it, to
  ;; go with it in one write (or for the loop, which writes what waits).
  (define frame-messages '("hl" "line" "grid" "scroll" "images" "image" "effects" "cursor"))

  ;; A sender to stream fd that never waits; (drop) lets the client go once
  ;; it falls too far behind.
  (define (stream-sender fd drop)
    (let ([b (make-outbox fd drop #f 0 '() 0 #f)])
      (lambda (msg)
        (unless (outbox-over? b)
          (let ([bv (encode-frame msg)])
            (outbox-tail-set! b (cons bv (outbox-tail b)))
            (outbox-bytes-set! b (+ (outbox-bytes b) (bytevector-length bv)))
            (unless (and (pair? msg) (member (car msg) frame-messages))
              (outbox-flush! b))
            (cond
             [(> (outbox-bytes b) outbox-limit)
              (outbox-over?-set! b #t)
              (outbox-pending-set! b #f)
              (outbox-tail-set! b '())
              (unless (memq b outboxes) (set! outboxes (cons b outboxes)))]
             [(and (not (outbox-empty? b)) (not (memq b outboxes)))
              (set! outboxes (cons b outboxes))]))))))

  ;; Stream fd is closed: what it had yet to take goes.
  (define (outbox-forget! fd)
    (set! outboxes (filter (lambda (b) (not (= (outbox-fd b) fd))) outboxes)))

  ;; After waiting: write to the streams that take more, and let go of the
  ;; clients too far behind.
  (define (outboxes-serve! writable)
    (for-each (lambda (b) (when (memv (outbox-fd b) writable) (outbox-flush! b))) outboxes)
    (let ([over (filter outbox-over? outboxes)])
      (set! outboxes (filter (lambda (b) (not (or (outbox-over? b) (outbox-empty? b)))) outboxes))
      (for-each (lambda (b) ((outbox-drop b))) over)))

  ;; ---------------------------------------------------------------------------
  ;; Streams: clients over a byte-stream descriptor, speaking frames

  (define (frame-sender fd)
    (lambda (msg)
      (let ([bv (encode-frame msg)])
        (kernel-write fd bv (bytevector-length bv)))))

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
                         (outbox-forget! fd)
                         (kernel-close fd)
                         (on-close)))])
        (set! src
              (make-source
               fd
               (lambda ()
                 (let ([got (kernel-read-some fd 0)])
                   (cond
                    [(not got)
                     ;; Gone: the client disconnected.
                     (if client (remove-client! client) (close!))]
                    [else
                     ;; Until it is closed: a stream whose first message was
                     ;; not "hello" says nothing more.
                     (for-each
                      (lambda (msg)
                        (cond
                         [(not (memq src the-sources))]
                         [client (client-receive! client msg)]
                         [(and (pair? msg) (equal? (car msg) "hello") (valid-hello? msg))
                          ;; ("hello" version name rows cols capabilities)
                          (let-values ([(version name rows cols caps) (apply values (cdr msg))])
                            (set! client (server-connect! name rows cols caps
                                                          (stream-sender fd (lambda () (if client (remove-client! client) (close!))))
                                                          close!))
                            ;; What else goes with the stream (voice, over
                            ;; iroh) knows the client by its descriptor.
                            (client-local-set! client 'stream-fd fd)
                            (when (> version protocol-version)
                              (with-client client (lambda () (message-error "Client speaks protocol ~a; this server ~a" version protocol-version)))))]
                         [else (close!)]))
                      (reader got (bytevector-length got)))])))
               (lambda () -1) void void))
        (add-source! src)
        src)]))

  ;; ---------------------------------------------------------------------------
  ;; Transports
  ;;
  ;; Editors are reached on Unix sockets (below), and on what extensions
  ;; add: iroh, the mesh extension's. A transport, by name, says which
  ;; targets it reaches, (target? s); connects to one, waiting, (connect s)
  ;; -> (values fd session editor), session what keeps it open and editor
  ;; the editor's identity; connects in the background, (connect-later s
  ;; done failed), calling (done fd session editor) or (failed why) and
  ;; returning a thunk that gives up; knows this editor's identity, (self?
  ;; editor); and accepts clients, (listen say), (say fmt arg ...) telling
  ;; how they join. label names it to people ("iroh").
  (define-record-type transport
    (fields name label target? connect connect-later self? listen))

  (define transports '())

  (define (define-transport! t)
    (set! transports (append (remp (lambda (o) (eq? (transport-name o) (transport-name t))) transports)
                             (list t))))

  ;; The transport that reaches target, or #f: a Unix socket's path.
  (define (transport-for target)
    (find (lambda (t) ((transport-target? t) target)) transports))

  (define (find-transport name)
    (find (lambda (t) (eq? (transport-name t) name)) transports))

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

  ;; Whether the socket at path may be trusted to be this user's editor's:
  ;; the default socket's directory, which may be in /tmp, must be this
  ;; user's alone, or someone else could have made it, and put a socket of
  ;; their own there for this user's quad to connect to (and type into).
  ;; A socket named otherwise ($QUAD_SOCKET, --listen, --connect) is the
  ;; user's choice.
  (define (socket-dir-safe? path)
    (or (not (equal? path (default-socket-path))) (getenv "QUAD_SOCKET")
        (kernel-private-dir? (path-dirname path))))

  ;; The socket paths this editor listens at.
  (define (server-listening-paths) (map car listening))

  ;; Accept clients on a Unix socket at path. A socket left by a server
  ;; that is gone is replaced; a live one is an error.
  (define (server-listen! path)
    (let ([dir (path-dirname path)])
      ;; Another's daemon may have made it in the meantime.
      (unless (file-exists? dir) (guard (e [#t (void)]) (mkdir dir #o700)))
      (unless (socket-dir-safe? path)
        (errorf 'server-listen! "~a is not this user's alone (it must be a directory of yours, mode 700): not listening there" dir)))
    ;; Whether a server listens there, and if not making the socket, as one
    ;; step: two editors starting at once would otherwise both find a
    ;; socket left by one that is gone, and the second would delete the
    ;; first's new one and listen in its place, leaving the first where no
    ;; client can reach it.
    (let* ([lock (or (kernel-lock (string-append path ".lock"))
                     (errorf 'server-listen! "cannot lock ~a.lock" path))]
           [fd (dynamic-wind
                 void
                 (lambda ()
                   (when (file-exists? path)
                     (let ([fd (kernel-unix-connect path)])
                       (if (>= fd 0)
                           (begin (kernel-close fd) (errorf 'server-listen! "a server is already listening at ~a" path))
                           (guard (e [#t (void)]) (delete-file path)))))
                   (kernel-unix-listen path))
                 (lambda () (kernel-close lock)))])
      (when (< fd 0) (errorf 'server-listen! "cannot listen at ~a" path))
      (set! listening (cons (list path fd (kernel-file-key path)) listening))
      (add-source! (make-source fd
                                (lambda ()
                                  (let ([c (kernel-accept fd)])
                                    (when (>= c 0) (serve-stream! c))))
                                (lambda () -1) void void))
      (add-hook! 'kill-editor-hook (lambda () (server-unlisten! path)))
      path))

  ;; Stop listening at path. The socket there goes only if it is still this
  ;; editor's: another may have replaced it since (it found this one gone
  ;; quiet, say), and its clients must still find it.
  (define (server-unlisten! path)
    (let ([e (assoc path listening)])
      (when e
        (set! listening (remq e listening))
        (for-each (lambda (s) (when (= (source-fd s) (cadr e)) (remove-source! s))) the-sources)
        (kernel-close (cadr e))
        (when (and (caddr e) (equal? (kernel-file-key path) (caddr e)))
          (guard (x [#t (void)]) (delete-file path)))))))
