;; mesh.sls -- editors and their clients over iroh
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; An editor can accept clients from anywhere over iroh (the Rust half's
;; mesh.rs, on iroh-mesh): each stream a client opens arrives as a
;; descriptor, served as a Unix socket's connections are. A client finds
;; the editor by its join code -- six words the editor announces itself
;; under on the mainline DHT -- or by its ticket.
;;
;; The code and the ticket are credentials: whoever has one can attach to
;; the editor, as anyone who can reach its socket can. So they are made up
;; afresh each time the editor starts listening, with a fresh identity,
;; and kept nowhere: once it stops, they are worth nothing.
(library (quad mesh)
  (export mesh-listen! mesh-listening? mesh-info mesh-target? mesh-connect-fd! mesh-connect-later!
          mesh-local? mesh-self?)
  (import (chezscheme) (quad util) (quad editor) (quad server) (quad native))

  ;; No relays or address lookup: only a ticket's addresses reach the
  ;; editor (QUAD_MESH_LOCAL=1, for tests on one machine).
  (define (mesh-local?) (equal? (getenv "QUAD_MESH_LOCAL") "1"))

  (define host #f)
  (define (mesh-listening?) (and host #t))

  ;; What the editor's endpoint has made known: an alist of id, ticket,
  ;; code and error, each #f until known.
  (define (mesh-info)
    (if host
        (map cons '(id ticket code error) (mesh-host-info host))
        '()))

  ;; Accept clients over iroh, with the join code (unless code? is #f) as
  ;; well as the ticket's key. (on-change info) runs as the endpoint makes
  ;; things known -- its ticket, its code -- or fails.
  (define mesh-listen!
    (case-lambda
     [() (mesh-listen! #t void)]
     [(code?) (mesh-listen! code? void)]
     [(code? on-change)
      (unless host
        (set! host (mesh-host-start code? (mesh-local?)))
        (let ([h host])
          (watch-fd! (mesh-host-fd h)
                     (lambda ()
                       (for-each (lambda (fd)
                                   (if (>= fd 0)
                                       (serve-stream! fd)
                                       (on-change (mesh-info))))
                                 (mesh-host-take! h))))))]))

  ;; Whether target is a join code or a ticket, rather than a socket path.
  (define (mesh-target? target) (and (mesh-target-kind target) #t))

  ;; A connection to the editor target names, as a descriptor to speak the
  ;; protocol on, and the session that keeps it open (keep it while it is
  ;; used).
  (define (mesh-connect-fd! target)
    (let ([s (mesh-connect target (mesh-local?))])
      (values (mesh-session-fd s) s (mesh-session-editor s))))

  ;; How to join, said in the editor.
  (define (say-how!)
    (let ([info (mesh-info)])
      (cond
       [(not host) (message "Not joinable over iroh: space space mesh-listen")]
       [(cdr (assq 'error info)) => (lambda (e) (message-error "iroh: ~a" e))]
       [(cdr (assq 'ticket info))
        => (lambda (ticket)
             (clipboard-push! (string-append "quad --connect=" ticket))
             (let ([code (cdr (assq 'code info))])
               (if code
                   (message "Join from anywhere: quad --connect=~a (a ticket is on the clipboard)" code)
                   (message (if (mesh-local?)
                                "Join with the ticket on the clipboard (local: no code, no DHT)"
                                "Join with the ticket on the clipboard (the code is still being made)")))))]
       [else (message "Joinable over iroh soon: the endpoint is starting")])))

  (at-load
   (define-command 'mesh-listen "Let clients join this editor over iroh, from anywhere"
     (lambda ()
       (let ([client (current-client)])
         (mesh-listen! #t (lambda (info) (when (memq client (clients)) (with-client client say-how!))))
         (say-how!))))
   (define-command 'mesh-info "How clients join this editor over iroh (copies a ticket)" say-how!))
  ;; Connect to the editor target names in the background, this editor
  ;; going on meanwhile (looking up a join code takes seconds): (done fd
  ;; session editor) once connected, as mesh-connect-fd! returns them, or
  ;; (failed why). Returns a thunk that gives up on it; a connection made
  ;; after that is closed.
  (define (mesh-connect-later! target done failed)
    (let* ([p (mesh-connect-start target (mesh-local?))]
           [src #f]
           [stop! (lambda () (when src (remove-source! src) (set! src #f) (set! p #f)))])
      (set! src
            (watch-fd! (mesh-pending-fd p)
                       (lambda ()
                         (let ([s (guard (e [#t (stop!) (failed (condition->string e)) #f])
                                    (mesh-pending-take! p))])
                           (when s
                             (stop!)
                             (done (mesh-session-fd s) s (mesh-session-editor s)))))))
      stop!))

  ;; Whether editor, an endpoint's ID, is this editor's own.
  (define (mesh-self? editor)
    (let ([id (assq 'id (mesh-info))])
      (and id (equal? (cdr id) editor)))))
