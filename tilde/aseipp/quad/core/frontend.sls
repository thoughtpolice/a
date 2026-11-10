;; frontend.sls -- what the editor's clients share: terminals and windows
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A client draws what the editor sends it and sends the editor its input
;; (tui.sls, gui.sls). What else a client does with the editor's messages,
;; and what it can do, extensions add here, so that the clients know none
;; of them: a handler for each kind of message beyond drawing (an
;; extension's: opening a URL, voice), and capabilities to say so.
;;
;; A client in the editor's own process connects with frontend-connect!,
;; and hands its input to deliver!. Either may be diverted: an extension
;; can route a client's input elsewhere (client-divert!), and what this
;; editor sends it is then not painted -- the relay extension shows
;; another editor in it so, painting that editor's frames with the
;; client's painter (client-painter).
(library (quad frontend)
  (export define-frontend-handler! frontend-handle!
          define-frontend-capability! frontend-capabilities
          frontend-connect! deliver! client-painter client-divert! client-diverted?
          frontend-hello!)
  (import (chezscheme) (quad util) (quad editor) (quad server) (only (quad protocol) protocol-version))

  ;; Say hello to an editor through send, as a client named name, rows by
  ;; cols, with capabilities caps, of person user, and open files there
  ;; at line.
  (define (frontend-hello! send name rows cols caps user files line)
    (send (list "hello" protocol-version name rows cols caps))
    (send (list "user" user))
    ;; Paths are the editor's to open, so they go absolute.
    (for-each (lambda (f) (send (list "open" (absolute-path f) line))) files))

  ;; ---------------------------------------------------------------------------
  ;; Messages beyond drawing, and capabilities

  ;; name -> (handler fd msg send), in the order defined: true if it took
  ;; msg. fd is the stream the message came on, for a client in a process
  ;; of its own (or one showing another editor); #f for one in the editor's
  ;; process. send sends a message back on it.
  (define handlers '())

  (define (define-frontend-handler! name handler)
    (set! handlers (append (remp (lambda (h) (eq? (car h) name)) handlers)
                           (list (cons name handler)))))

  ;; Whether some extension took msg.
  (define (frontend-handle! fd msg send)
    (exists (lambda (h) ((cdr h) fd msg send)) handlers))

  ;; name -> a thunk giving the capabilities (strings) it adds to every
  ;; client: what this process can do for its person (open a URL, carry
  ;; voice), whatever the client draws on.
  (define capabilities '())

  (define (define-frontend-capability! name thunk)
    (set! capabilities (append (remp (lambda (c) (eq? (car c) name)) capabilities)
                               (list (cons name thunk)))))

  (define (frontend-capabilities)
    (apply append (map (lambda (c) ((cdr c))) capabilities)))

  ;; ---------------------------------------------------------------------------
  ;; Clients in this process

  ;; Connect a client: (paint msg) draws what the editor sends it, unless it
  ;; is diverted; close is called once it goes. Returns the client.
  (define (frontend-connect! name rows cols capabilities paint close)
    ;; The editor may send to it while it connects, before c is known.
    (let ([c #f])
      (set! c (server-connect! name rows cols capabilities
                               (lambda (msg) (unless (and c (client-diverted? c)) (paint msg)))
                               close))
      (client-local-set! c 'paint paint)
      c))

  ;; How client c paints a message: frontend-connect!'s paint.
  (define (client-painter c) (client-local c 'paint void))

  ;; Send input from client c's terminal or window to the editor, or where
  ;; it is diverted to.
  (define (deliver! c msg)
    (let ([route (client-route c)])
      (if route (route msg) (client-receive! c msg)))))
