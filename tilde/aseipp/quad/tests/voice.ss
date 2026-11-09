;; voice.ss -- voice for the people at this editor's own clients
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run with QUAD_VOICE_INPUT and QUAD_VOICE_OUTPUT naming files (BUILD's
;; test-voice): the microphone is a tone this writes, the speakers a file;
;; and with a daemon at $QUAD_SOCKET, to switch to.

;; A tone at hz for seconds, as raw samples (16-bit little-endian, mono,
;; 48 kHz), to path.
(define (write-tone! path hz seconds)
  (let* ([n (* 48000 seconds)] [bv (make-bytevector (* 2 n))])
    (do ([i 0 (+ i 1)]) ((= i n))
      (bytevector-s16-set! bv (* 2 i)
                           (exact (round (* 8000 (sin (/ (* 2 3.141592653589793 hz i) 48000)))))
                           (endianness little)))
    (call-with-port (open-file-output-port path (file-options no-fail)) (lambda (p) (put-bytevector p bv)))))

(define (wait! ms) (sleep (make-time 'time-duration (* ms 1000000) 0)))

(write-tone! (getenv "QUAD_VOICE_INPUT") 440 4)

(headless-start! 16 70)
(define a (current-client))
(define b (headless-client! 16 70))
(set-client-user! a "alice")
(set-client-user! b "bob")
(redraw!)
(define (message-of c) (with-client c (lambda () (let ([m (current-message)]) (and m (cdr m))))))
(define (status-of c) (list-ref (screen-of c) 14))

;; Nobody is in voice, and nothing says so.
(check "nobody in voice" (and (not (in-voice a)) (not (string-contains (status-of b) "voice"))))
(check "nobody talking" (null? (voice-talking)))

;; Alice turns it on: everyone is told, and the status line says so.
(use-client! a)
(press! "space" "j" "a")
(expect-equal "alice is in voice" (in-voice a) "on")
(check "alice is told how" (string-contains (message-of a) "space j m mutes"))
(expect-equal "bob is told" (message-of b) "alice enabled voice")
(check "in the chat" (member "alice enabled voice" (chat-lines)))
(redraw!)
(check "bob sees it" (string-contains (status-of b) "voice: 1"))

;; Her microphone (the tone) is heard: she is talking, which the status
;; line says as it starts, with nothing else to draw it.
(run-until "bob sees alice talking" (lambda () (string-contains (status-of b) "talking: alice")))
(check "alice is talking" (equal? (voice-talking) '(-1)))

;; So does the people list.
(use-client! b)
(press! "space" "j" "l")
(check "the list says who is in voice"
       (let ([row (screen-row-of b "alice  ")])
         (and row (string-contains (list-ref (screen-of b) row) "in voice, talking"))))
(press! "esc")
(use-client! a)

;; Muted, she is not.
(press! "space" "j" "m")
(expect-equal "muted" (in-voice a) "muted")
(redraw!)
(check "her status says so" (string-contains (status-of a) "muted"))
(run-until "bob sees her stop" (lambda () (string-contains (status-of b) "voice: 1")))
(check "nobody talking when muted" (null? (voice-talking)))
(press! "space" "j" "m")
(expect-equal "unmuted" (in-voice a) "on")

;; Bob joins too, then leaves; his sound is this process's, which stays on
;; for alice.
(use-client! b)
(press! "space" "j" "a")
(check "two in voice" (and (in-voice a) (in-voice b)))
(press! "space" "j" "a")
(check "bob left" (and (in-voice a) (not (in-voice b))))
(expect-equal "alice is told" (message-of a) "bob left voice")

;; Muting needs voice.
(press! "space" "j" "m")
(check "not in voice" (string-contains (message-of b) "Not in voice"))

;; Alice switches to another editor: she leaves voice here, where her
;; microphone would otherwise speak to both.
(use-client! a)
(relay-connect! a #f)
(check "alice left" (not (in-voice a)))
(check "in the chat too" (member "alice left voice, for another editor" (chat-lines)))
(press! "space" "j" "v")
(run-until "back" (lambda () (not (relayed? a))))
(wait! 400)
(check "nobody talking at the end" (null? (voice-talking)))
(check "what she heard went to the speakers"
       (> (file-length (open-file-input-port (getenv "QUAD_VOICE_OUTPUT"))) 0))
