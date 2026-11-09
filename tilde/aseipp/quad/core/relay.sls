;; relay.sls -- a client of this editor showing another editor instead
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A terminal or window attached in this process (tui.sls, gui.sls) can
;; switch to an editor elsewhere -- a daemon on this machine, or one
;; reached over iroh by its join code -- as tmux's switch-client does: the
;; `connect` command (space j o). Its keys go there, and that editor's
;; frames are painted in its place; this editor keeps running, for its
;; other clients, and the client comes back to it when the other editor
;; says goodbye (leaving it with space j v) or goes away.
;;
;; Clients in this process register how they paint a server's message
;; (frontend!) and hand their input to deliver!, which sends it to
;; whichever editor they show; frontend-sender wraps what this editor sends
;; them, so that it is not painted over the other's.
(library (quad relay)
  (export frontend! frontend-sender deliver! relayed? relay-connect! relay-connect-later! relay-end!)
  (import (chezscheme) (quad util) (quad kernel) (quad protocol) (quad buffer)
          (quad editor) (quad commands) (quad display) (quad server) (quad mesh) (quad voice))

  ;; A client's connection to another editor.
  (define-record-type relay (fields fd session send reader (mutable source) target))

  (define (relayed? c) (and (client-local c 'relay #f) #t))

  ;; Register how client c paints a server's message: (paint msg).
  (define (frontend! c paint) (client-local-set! c 'paint paint))

  ;; What this editor sends a client goes through this, so that a client
  ;; showing another editor does not paint this one's frames over it.
  ;; (client) gives the client, which does not exist yet when its sender
  ;; is made.
  (define (frontend-sender client paint)
    (lambda (msg)
      (let ([c (client)])
        (unless (and c (relayed? c)) (paint msg)))))

  ;; Leave the other editor client c shows, if it shows one: it is told,
  ;; and the connection to it closes.
  (define (relay-close! c)
    (let ([r (client-local c 'relay #f)])
      (when r
        (client-local-set! c 'relay #f)
        (when (relay-source r) (remove-source! (relay-source r)))
        (guard (e [#t (void)]) ((relay-send r) '("detach")))
        (voice-forget! (relay-fd r))
        (kernel-close (relay-fd r)))
      r))

  ;; A client that goes while it shows another editor leaves that one too,
  ;; which would otherwise keep it as a client that never says anything.
  (at-load (add-hook! 'client-detach-hook (lambda (c) (relay-give-up! c) (relay-close! c))))

  ;; Bring client c back to this editor.
  (define (relay-end! c why)
    (when (relay-close! c)
      (begin
        ;; Its screen shows the other editor's frame and title: draw it
        ;; whole, and title it again.
        (invalidate-client! c)
        (let ([v (client-view c)])
          (when (and v (client-has? c "title"))
            (client-send! c (list "title" (string-append "quad — " (buffer-name (view-buffer v)))))))
        (with-client c
          (lambda ()
            (message "Back in this editor~a" (if why (string-append ": " why) "")))))))

  ;; Input from client c's terminal or window: to the editor it shows. A
  ;; new size goes to both, so that this editor has it when c comes back.
  (define (deliver! c msg)
    (let ([r (client-local c 'relay #f)])
      (cond
       [(not r) (client-receive! c msg)]
       [else
        (guard (e [#t (relay-end! c "the other editor went away")])
          ((relay-send r) msg))
        (when (equal? (car msg) "resize") (client-receive! c msg))])))

  ;; What target names -- a socket path, an iroh join code or ticket, or
  ;; #f (or "") for this machine's daemon -- as a path or a mesh target.
  (define (target-path target)
    (if (and target (not (string=? target ""))) target (default-socket-path)))

  ;; Showing this editor in one of its own clients would make it its own
  ;; client, drawing for itself, and waiting on itself once a frame is
  ;; more than its socket holds.
  (define (refuse-self! what)
    (errorf 'connect "~a is this editor" what))

  ;; A descriptor connected to the socket at path, not this editor's own
  ;; however it is spelled.
  (define (socket-fd path)
    (when (exists (lambda (p) (kernel-same-file? path p)) (server-listening-paths))
      (refuse-self! path))
    (let ([fd (kernel-unix-connect path)])
      (when (< fd 0) (errorf 'connect "no editor is listening at ~a" path))
      fd))

  ;; A descriptor connected to target, and the session keeping it open,
  ;; once connected (an iroh target waits for it).
  (define (target-fd target)
    (let ([path (target-path target)])
      (if (mesh-target? path)
          (let-values ([(fd session editor) (mesh-connect-fd! path)])
            (when (mesh-self? editor) (kernel-close fd) (refuse-self! path))
            (values fd session))
          (values (socket-fd path) #f))))

  ;; Switch client c to the editor at target (see target-path), waiting
  ;; until connected.
  (define (relay-connect! c target)
    (when (relayed? c) (errorf 'connect "already showing another editor"))
    (let-values ([(fd session) (target-fd target)])
      (relay-start! c target fd session)))

  ;; Switch client c to the editor at target, connecting in the background
  ;; where that takes a while (over iroh), so that this editor and its
  ;; other clients go on meanwhile; (failed why) if it cannot. A client
  ;; that leaves first gives up on it.
  (define (relay-connect-later! c target failed)
    (when (relayed? c) (errorf 'connect "already showing another editor"))
    (when (client-local c 'connecting #f) (errorf 'connect "already connecting to another editor"))
    (let ([path (target-path target)])
      (if (not (mesh-target? path))
          (relay-connect! c target)
          (client-local-set!
           c 'connecting
           (mesh-connect-later!
            path
            (lambda (fd session editor)
              (client-local-set! c 'connecting #f)
              (cond
               [(mesh-self? editor) (kernel-close fd) (failed (format "~a is this editor" path))]
               [(not (memq c (clients))) (kernel-close fd)]
               [else (relay-start! c target fd session)]))
            (lambda (why)
              (client-local-set! c 'connecting #f)
              (failed why)))))))

  ;; Client c gives up on the editor it is connecting to, if any.
  (define (relay-give-up! c)
    (let ([stop (client-local c 'connecting #f)])
      (when stop (client-local-set! c 'connecting #f) (stop))))

  ;; Switch client c to the editor on descriptor fd, which target named.
  (define (relay-start! c target fd session)
    (let* ([send (frame-sender fd)]
           [r (make-relay fd session send (make-frame-reader) #f
                          (if (and target (not (string=? target ""))) target "this machine's daemon"))])
      (send (list "hello" protocol-version (client-name c) (client-rows c) (client-cols c)
                  (client-capabilities c)))
      (send (list "user" (client-user c)))
      (client-local-set! c 'relay r)
      ;; What c did here that the other editor would do too (voice:
      ;; this process's microphone is c's person's) stops.
      (run-hooks 'client-relay-hook c)
      (relay-source-set! r
                         (watch-fd! fd
                                    (lambda ()
                                      (let ([got (kernel-read-some fd 0)])
                                        (if (not got)
                                            (relay-end! c "the other editor went away")
                                            (let ([paint (client-local c 'paint void)])
                                              (let loop ([msgs ((relay-reader r) got (bytevector-length got))])
                                                (cond
                                                 [(null? msgs) (void)]
                                                 [(equal? (caar msgs) "bye") (relay-end! c #f)]
                                                 ;; Voice is this process's to carry: its
                                                 ;; person is here.
                                                 [(voice-message! fd (car msgs) send) (loop (cdr msgs))]
                                                 [else (paint (car msgs)) (loop (cdr msgs))]))))))))
      r))

  (at-load
   (define-command 'connect
     "Show another editor here: a daemon, by its socket, or one anywhere, by its join code"
     (lambda ()
       (let ([c (current-client)])
         (read-string-dialog
          "Connect to an editor"
          "A socket path, or an iroh join code or ticket; empty for this machine's daemon. Leave it (space j v) to come back."
          (lambda (target)
            (guard (e [#t (message-error "~a" (condition->string e))])
              (when (mesh-target? (string-trim target)) (message "Connecting over iroh..."))
              (relay-connect-later! c (string-trim target)
                                    (lambda (why)
                                      (when (memq c (clients))
                                        (with-client c (lambda () (message-error "~a" why))))))))))))
   (define-key (keymap-lookup-target space-keymap "j") "o" 'connect "Connect")))
