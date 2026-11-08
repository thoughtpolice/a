;; protocol.ss -- the wire format: MessagePack, frames, events as messages
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define (round-trip x) (msgpack-decode (msgpack-encode x)))
(define (bytevector-append . bvs)
  (u8-list->bytevector (apply append (map bytevector->u8-list bvs))))

;; Values survive the trip, in their read form.
(for-each
 (lambda (x) (expect-equal (format "round trip ~s" x) (round-trip x) x))
 (list 0 1 127 128 255 256 65535 65536 (- (expt 2 32) 1) (expt 2 40) (- (expt 2 64) 1)
       -1 -32 -33 -128 -129 -32768 -32769 (- (expt 2 31)) (- (expt 2 63))
       #t #f "" "hello" "λ — ünïcødé" (make-string 40 #\x) (make-string 300 #\y) (make-string 70000 #\z)
       '() '(1 2 3) (iota 20) (iota 70000) '("line" 3 0 (("a" 1 4) ("" 2 1)))
       (bytevector 1 2 3) 1.5 -0.25))
(expect-equal "vectors read as lists" (round-trip '#(1 "a")) '(1 "a"))
(expect-equal "symbols read as strings" (round-trip 'key) "key")

;; Known encodings, so other implementations can check against them.
(expect-equal "encoding" (msgpack-encode '("key" "j" 0 #f "press"))
              (bytevector #x95 #xa3 #x6b #x65 #x79 #xa1 #x6a #x00 #xc2 #xa5 #x70 #x72 #x65 #x73 #x73))
(expect-equal "nil reads as #f" (msgpack-decode (bytevector #xc0)) #f)
(expect-equal "maps read as alists" (msgpack-decode (bytevector #x81 #xa1 #x61 #x01)) '(("a" . 1)))

;; Frames arrive whole however the stream splits them.
(let* ([msgs '(("hello" 1 "test" 24 80 ("release-events")) ("key" "a" 0 "a" "press") ("flush"))]
       [stream (apply bytevector-append (map encode-frame msgs))]
       [reader (make-frame-reader)]
       [got '()])
  (let loop ([i 0])
    (when (< i (bytevector-length stream))
      (let* ([n (min 3 (- (bytevector-length stream) i))] [chunk (make-bytevector n)])
        (bytevector-copy! stream i chunk 0 n)
        (set! got (append got (reader chunk n)))
        (loop (+ i n)))))
  (expect-equal "frames reassemble" got msgs))

;; Events and messages.
(for-each
 (lambda (e)
   (let ([back (message->event (round-trip (event->message e)))])
     (expect-equal "event round trip" (event->message back) (event->message e))))
 (list (make-key-event "A" mod-alt #f 'press) (make-key-event "r" 0 "r" 'release)
       (make-paste-event "pasted\ntext") (make-mouse-event 'drag 0 10 3 mod-shift)
       (make-clipboard-event "c" "clip") (make-focus-event #t)))
(expect-equal "spec->key-event" (key-event->spec (spec->key-event "ctrl+alt+x")) "ctrl+alt+x")
