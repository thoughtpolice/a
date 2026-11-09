;; voice.sls -- talking to the people here, as you edit together
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; People attached to an editor can talk to each other: whoever turns
;; voice on hears everyone else who has, and is heard by them. Nobody is
;; heard, or hears, until they turn it on themselves, and everyone is told
;; when someone does.
;;
;;   space j a    voice on or off
;;   space j m    mute or unmute your microphone
;;
;; The editor is the hub: a client over iroh sends its person's speech to
;; the editor, which sends it on to everyone else in voice (see the Rust
;; half's voice/). The sound is the client's own process's -- the person is
;; there -- except for clients on the editor's own machine (its terminal,
;; its windows, clients on its socket), whose sound the editor's process
;; makes itself (core/voice.sls). The status line says who is in voice,
;; and who is talking.
(library (quad ext voice)
  (export in-voice voice-toggle! voice-mute!)
  (import (chezscheme) (quad util) (quad buffer) (quad editor) (quad commands) (quad display)
          (quad server) (quad native) (quad voice) (quad ext people))

  ;; Client c's part in voice: #f, "on" or "muted".
  (define (in-voice c) (client-local c 'voice #f))
  (define (voicers) (filter in-voice (people)))

  ;; The iroh connection client c came on, if it did: its descriptor.
  (define (link-of c)
    (let ([fd (client-local c 'stream-fd #f)])
      (and fd (voice-link? fd) fd)))

  ;; Who is talking, as the Rust half last said: descriptors, and -1 for
  ;; this process's own person.
  (define talking '())
  (define watching? #f)
  (define (watch!)
    (unless watching?
      (set! watching? #t)
      (watch-fd! (voice-events-fd) (lambda () (set! talking (voice-talking))))))

  (define (talking? c)
    (let ([link (link-of c)])
      (if link
          (memv link talking)
          (and (memv -1 talking) (equal? (in-voice c) "on")))))

  ;; Set client c's part in voice to mode ("on", "muted" or "off"): its
  ;; process's sound, wherever that is.
  (define (set-mode! c mode)
    (let ([link (link-of c)])
      (cond
       [link
        (unless (client-has? c "voice")
          (errorf 'voice "this client cannot do voice: a newer quad can"))
        (if (equal? mode "off")
            (voice-leave! link)
            (voice-join! link #t))
        (client-send! c (list "voice" mode))]
       [else (voice-want! c mode)])
      (client-local-set! c 'voice (and (not (equal? mode "off")) mode))))

  ;; Turn the current client's voice on, or off.
  (define (voice-toggle!)
    (let ([c (current-client)])
      (guard (e [#t (message-error "Voice: ~a" (condition->string e))])
        (watch!)
        (cond
         [(in-voice c)
          (set-mode! c "off")
          (announce! #f "~a left voice" (client-user c))]
         [else
          (set-mode! c "on")
          (announce! #f "~a enabled voice" (client-user c))
          (message "Voice on~a: space j m mutes, space j a leaves"
                   (let ([n (- (length (voicers)) 1)])
                     (if (= n 0) ", with nobody else yet" (format ", with ~a other~a" n (if (= n 1) "" "s")))))]))))

  ;; Mute the current client's microphone, or unmute it.
  (define (voice-mute!)
    (let* ([c (current-client)] [mode (in-voice c)])
      (guard (e [#t (message-error "Voice: ~a" (condition->string e))])
        (cond
         [(not mode) (message "Not in voice: space j a joins")]
         [(equal? mode "on") (set-mode! c "muted") (message "Muted")]
         [else (set-mode! c "on") (message "Unmuted")]))))

  ;; Who is in voice, for the status line: who is talking, else how many
  ;; are in it; and whether this client is muted.
  (define (status v)
    (let ([vs (voicers)] [me (view-client v)])
      (and (pair? vs)
           (let ([speaking (filter talking? vs)])
             (cons (format " ~a~a "
                           (if (pair? speaking)
                               (string-append "talking: " (string-join (map client-user speaking) ", "))
                               (format "voice: ~a" (length vs)))
                           (if (equal? (in-voice me) "muted") ", muted" ""))
                   (if (pair? speaking) 'ui.statusline.insert 'ui.statusline.dim))))))

  ;; In the people list: who is in voice, muted, or talking.
  (define (note c)
    (let ([mode (in-voice c)])
      (cond [(not mode) #f]
            [(equal? mode "muted") "in voice, muted"]
            [(talking? c) "in voice, talking"]
            [else "in voice"])))

  (at-load
   (define-person-note! note)
   ;; A client that leaves leaves voice.
   (add-hook! 'client-detach-hook
              (lambda (c)
                (when (in-voice c)
                  (guard (e [#t (void)]) (set-mode! c "off"))
                  (announce! c "~a left voice" (client-user c)))))
   ;; A client that switches to another editor (core/relay.sls) leaves
   ;; voice here: in voice there, its speech would go to both.
   (add-hook! 'client-relay-hook
              (lambda (c)
                (when (in-voice c)
                  (guard (e [#t (void)]) (set-mode! c "off"))
                  (announce! c "~a left voice, for another editor" (client-user c)))))
   ;; A client whose process could not make sound: ("failed" why).
   (add-hook! 'client-voice-hook
              (lambda (c args)
                (when (and (pair? args) (equal? (car args) "failed") (in-voice c))
                  (let ([link (link-of c)]) (when link (voice-leave! link)))
                  (client-local-set! c 'voice #f)
                  (with-client c (lambda () (message-error "Voice: ~a" (if (pair? (cdr args)) (cadr args) "failed"))))
                  (announce! c "~a left voice" (client-user c)))))
   (define-status-segment! 'right status)

   (define-command 'voice "Talk with the people here: voice on or off" voice-toggle!)
   (define-command 'voice-mute "Mute or unmute your microphone, in voice" voice-mute!)

   (let ([editor (keymap-lookup-target space-keymap "j")])
     (define-key editor "a" 'voice "Voice")
     (define-key editor "m" 'voice-mute "Mute"))))
