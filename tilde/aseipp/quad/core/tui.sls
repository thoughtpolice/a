;; tui.sls -- the terminal client
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A terminal is a client like any other: it sends the server events
;; (key presses, the mouse, pastes) and draws the messages the server sends.
;; It runs either in the server's process (tui-attach!), exchanging messages
;; as lists, or as a process of its own (tui-connect!), exchanging frames
;; with a server over a socket.
(library (quad tui)
  (export tui-attach! tui-connect!)
  (import (chezscheme) (quad util) (quad kernel) (quad event) (quad term)
          (quad protocol) (quad editor) (quad display) (quad server))

  (define (terminal-client-name) (format "tui:~a" (or (getenv "TERM") "terminal")))

  ;; Handle a message from the server that painting does not: returns #f
  ;; when the server said goodbye.
  (define (handle! tty msg send redraw)
    (cond
     [(tty-paint! tty msg) #t]
     [(equal? (car msg) "suspend")
      (tty-suspend! tty)
      (tty-resume! tty)
      (send (list "resize" (tty-rows tty) (tty-cols tty)))
      (redraw)
      #t]
     [(equal? (car msg) "bye") #f]
     [else #t]))

  ;; Events from the terminal, as messages to send.
  (define (input-messages events) (map event->message events))

  ;; ---------------------------------------------------------------------------
  ;; In the server's process

  ;; Open the terminal and connect it to this process's server, as a source
  ;; in its loop. Returns the client.
  (define (tui-attach!)
    (let* ([tty (open-tty)]
           [client #f]
           [src #f]
           [close (lambda ()
                    (remove-source! src)
                    (close-tty! tty)
                    ;; The terminal was the editor's reason to run, unless
                    ;; it is a daemon.
                    (unless (editor-daemon?) (editor-stop!)))]
           [send (lambda (msg)
                   (handle! tty msg
                            (lambda (m) (client-receive! client m))
                            (lambda () (invalidate-client! client))))])
      (set! client (server-connect! (terminal-client-name) (tty-rows tty) (tty-cols tty)
                                    (tty-capabilities tty) send close))
      (set! src
            (make-source
             (tty-in-fd tty)
             (lambda ()
               (let ([events (tty-read-available! tty)])
                 (if events
                     (for-each (lambda (m) (client-receive! client m)) (input-messages events))
                     (remove-client! client))))
             (lambda () (tty-pending-timeout tty))
             (lambda ()
               (for-each (lambda (m) (client-receive! client m))
                         (input-messages (tty-flush-pending! tty))))
             (lambda ()
               (when (tty-take-resize! tty)
                 (client-receive! client (list "resize" (tty-rows tty) (tty-cols tty)))))))
      (add-source! src)
      client))

  ;; ---------------------------------------------------------------------------
  ;; In a process of its own

  ;; Connect the terminal to the server listening at socket `path` (or on
  ;; descriptor `path`, connected already), open `files` there, and run
  ;; until the server says goodbye or the terminal closes. Returns the exit
  ;; status.
  (define (tui-connect! path files line)
    (let ([fd (if (fixnum? path) path (kernel-unix-connect path))])
      (when (< fd 0) (errorf 'quad "no server is listening at ~a" path))
      (let* ([tty (open-tty)]
             [send (frame-sender fd)]
             [reader (make-frame-reader)]
             [buf (make-bytevector 65536)])
        (send (list "hello" protocol-version (terminal-client-name) (tty-rows tty) (tty-cols tty)
                    (tty-capabilities tty)))
        ;; Paths are the server's to open, so they go absolute.
        (for-each (lambda (f)
                    (send (list "open" (if (string-prefix? "/" f) f (path-join (current-directory) f)) line)))
                  files)
        (let loop ()
          (let* ([timeout (tty-pending-timeout tty)]
                 [ready (kernel-poll (list (tty-in-fd tty) fd) timeout)]
                 [continue?
                  (and
                   ;; The terminal.
                   (if (memv (tty-in-fd tty) ready)
                       (let ([events (tty-read-available! tty)])
                         (if events (begin (for-each send (input-messages events)) #t) #f))
                       (begin
                         (when (null? ready) (for-each send (input-messages (tty-flush-pending! tty))))
                         #t))
                   ;; The server.
                   (if (memv fd ready)
                       (let ([n (kernel-read fd buf (bytevector-length buf) 0)])
                         (and (> n -1)
                              (for-all (lambda (msg) (handle! tty msg send (lambda () (send '("redraw")))))
                                       (reader buf n))))
                       #t))])
            (when (tty-take-resize! tty) (send (list "resize" (tty-rows tty) (tty-cols tty))))
            (if continue?
                (loop)
                (begin
                  (guard (e [#t (void)]) (send '("detach")))
                  (close-tty! tty)
                  (kernel-close fd)
                  0))))))))
