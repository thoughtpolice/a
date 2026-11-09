;; voice.sls -- this process's part in voice: its person's sound
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; People attached to an editor over iroh can talk (ext/voice.sls has the
;; commands; the Rust half's voice/ carries the sound). Whoever is at a
;; process -- the editor's own terminal or window, or a client elsewhere
;; -- hears and speaks through that process. Two things may want it to:
;; the editor, for a person at one of its own clients, and a client
;; process, when the editor it is attached to says so (the "voice"
;; message). Each says what it wants under a key of its own; the sound is
;; on while anyone wants it on, muted while someone wants it but nobody
;; unmuted, and off otherwise, so the microphone is open only while
;; someone here is in voice and not muted.
(library (quad voice)
  (export voice-want! voice-message! voice-forget!)
  (import (chezscheme) (quad util) (quad native) (quad editor))

  (define wants '())                    ; key -> "on" or "muted"

  (define (combined)
    (cond [(member "on" (map cdr wants)) "on"]
          [(pair? wants) "muted"]
          [else "off"]))

  ;; key wants this process's sound mode: "on", "muted" or "off". An error
  ;; (no sound server) leaves things as they were.
  (define (voice-want! key mode)
    (let ([before wants])
      (set! wants (if (equal? mode "off")
                      (remp (lambda (w) (equal? (car w) key)) wants)
                      (cons (cons key mode) (remp (lambda (w) (equal? (car w) key)) wants))))
      (guard (e [#t (set! wants before) (raise e)])
        (voice-local! (combined)))))

  ;; A client process: the editor at fd said ("voice" mode). Its link goes
  ;; in voice, or out, and so does this process's sound; what fails is
  ;; said back ("voice" "failed" why). Whether msg was voice's.
  (define (voice-message! fd msg send)
    (and (pair? msg) (equal? (car msg) "voice") (pair? (cdr msg))
         (let ([mode (cadr msg)])
           (guard (e [#t (voice-forget! fd)
                         (send (list "voice" "failed" (condition->string e)))])
             (cond
              [(equal? mode "off") (voice-forget! fd)]
              [else (voice-want! (cons 'link fd) mode)
                    (voice-join! fd #f)]))
           #t)))

  ;; The connection at fd is gone, or out of voice.
  (define (voice-forget! fd)
    (voice-leave! fd)
    (voice-want! (cons 'link fd) "off")))
