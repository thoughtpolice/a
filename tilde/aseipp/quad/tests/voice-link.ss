;; voice-link.ss -- voice over iroh, both ways, between processes
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A client over iroh, speaking the protocol itself (BUILD's test-voice
;; runs the editor, a daemon on $QUAD_TICKET, and this). The editor's own
;; person speaks a 440 Hz tone ($QUAD_TEST_DIR/host-in.raw), this client's
;; a 660 Hz one; each must hear the other's.

(define dir (getenv "QUAD_TEST_DIR"))
(define (in-dir f) (string-append dir "/" f))

(define (write-tone! path hz seconds)
  (let* ([n (* 48000 seconds)] [bv (make-bytevector (* 2 n))])
    (do ([i 0 (+ i 1)]) ((= i n))
      (bytevector-s16-set! bv (* 2 i)
                           (exact (round (* 8000 (sin (/ (* 2 3.141592653589793 hz i) 48000)))))
                           (endianness little)))
    (call-with-port (open-file-output-port path (file-options no-fail)) (lambda (p) (put-bytevector p bv)))))

;; The power of frequency hz in the samples of file path from second
;; `from`, for a second (Goertzel's algorithm).
(define (power-at path hz from)
  (let* ([bv (call-with-port (open-file-input-port path) get-bytevector-all)]
         [start (* 48000 from)]
         [n 48000]
         [coeff (* 2 (cos (/ (* 2 3.141592653589793 hz) 48000)))])
    (if (or (eof-object? bv) (< (bytevector-length bv) (* 2 (+ start n))))
        0
        (let loop ([i 0] [s1 0.0] [s2 0.0])
          (if (= i n)
              (/ (- (+ (* s1 s1) (* s2 s2)) (* coeff s1 s2)) n)
              (let ([x (bytevector-s16-ref bv (* 2 (+ start i)) (endianness little))])
                (loop (+ i 1) (- (+ x (* coeff s1)) s2) s1)))))))

(define (wait! ms) (sleep (make-time 'time-duration (* ms 1000000) 0)))

(write-tone! (in-dir "host-in.raw") 440 4)
(write-tone! (getenv "QUAD_VOICE_INPUT") 660 8)

;; Attach over iroh, as a client that can do voice.
(define-values (fd session editor) (mesh-connect-fd! (getenv "QUAD_TICKET")))
(define send (frame-sender fd))
(define reader (make-frame-reader))
(send (list "hello" protocol-version "voice-test" 24 80 '("voice")))
(send (list "user" "carol"))

;; Messages from the editor, for ms: voice's are handled as a client
;; process handles them; results are kept.
(define results '())
(define (pump! ms)
  (let ([until (+ (real-time) ms)])
    (let loop ()
      (when (< (real-time) until)
        (let ([got (kernel-read-some fd 50)])
          (unless got (errorf 'voice-link "the editor went away"))
          (for-each (lambda (msg)
                      (cond
                       [(voice-message! fd msg send) (void)]
                       [(equal? (car msg) "result") (set! results (cons (cdr msg) results))]
                       [else (void)]))
                    (reader got (bytevector-length got))))
        (loop)))))

(define (eval-there! id expr)
  (send (list "eval" id expr))
  (pump! 300)
  (let ([r (assv id results)])
    (unless (and r (cadr r)) (errorf 'voice-link "~a: ~s" expr r))
    (caddr r)))

;; The editor's person turns voice on, then this client does.
(eval-there! 1 "(voice-want! 'host \"on\")")
(eval-there! 2 "(voice-toggle!)")
(check "in voice there" (equal? (eval-there! 3 "(in-voice (current-client))") "\"on\""))
(pump! 2500)

;; Each hears the other: the editor this client's 660 Hz, and this client
;; the editor's 440 Hz.
(check "the editor hears this client talking"
       (equal? (eval-there! 4 "(length (filter (lambda (fd) (>= fd 0)) (voice-talking)))") "1"))
(let ([here (getenv "QUAD_VOICE_OUTPUT")] [there (in-dir "host-out.raw")])
  (check "this client hears 440 Hz" (> (power-at here 440 1) (* 20 (+ 1 (power-at here 660 1)))))
  (check "the editor hears 660 Hz" (> (power-at there 660 1) (* 20 (+ 1 (power-at there 440 1)))))
  (check "loud enough" (> (power-at here 440 1) 1e6)))

;; Muted and speaking again, this client is still heard: what it says goes
;; on from where it was, not from the start.
(eval-there! 7 "(voice-mute!)")
(pump! 300)
(eval-there! 8 "(voice-mute!)")
(pump! 1500)
(let* ([there (in-dir "host-out.raw")]
       [last (- (quotient (file-length (open-file-input-port there)) 96000) 1)])
  (check "the editor hears this client after a mute"
         (> (power-at there 660 last) (* 20 (+ 1 (power-at there 440 last))))))

;; Leaving: the editor says so, and this client's sound stops.
(eval-there! 5 "(voice-toggle!)")
(check "out of voice there" (equal? (eval-there! 6 "(in-voice (current-client))") "#f"))
(pump! 400)
(check "nobody talking here" (null? (voice-talking)))
(send '("detach"))
