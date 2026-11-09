;; protocol.sls -- the client protocol: messages, and their wire form
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A message is a list whose head is a string naming it. Clients in the
;; server's own process exchange the lists directly; others exchange them in
;; frames: a 4-byte big-endian length, then the message as MessagePack (an
;; array). docs/design.md lists the messages; in short:
;;
;;   client -> server
;;     ("hello" version name rows cols capabilities)   first, once
;;     ("user" name)        who is at the client, for the others to see
;;     ("key" name mods text kind)  ("paste" text)  ("mouse" kind button col row mods)
;;     ("focus" in?)  ("resize" rows cols)  ("clipboard" target text)
;;     ("redraw")  ("open" path line)  ("eval" id expression)  ("detach")
;;     ("voice" "failed" why): the client could not do what "voice" said
;;
;;   server -> client
;;     ("hl" id fg bg flags underline-color link)  ("grid" rows cols),
;;       link the URL the highlight's text leads to, or #f
;;       ("line" row col cells),
;;       each cell (text [hl [repeat]]) as in Neovim's grid_line
;;     ("scroll" top bottom n): rows top to bottom (exclusive) move up n
;;       (down, for n < 0), sent to clients with the "scroll" capability
;;     ("cursor" row col shape) or ("cursor" #f)  ("flush"): shape "block",
;;       "bar", "underline", or "hidden": where the text cursor is, which
;;       the client does not draw (the selection's colors show it), for
;;       screen readers; sent only to clients with the "hidden-cursor"
;;       capability
;;     ("clipboard-set" target text)  ("clipboard-get" target)  ("title" text)
;;     ("cwd" path)  ("pointer" shape)  ("bell")  ("suspend")
;;     ("open-url" url): open it, on the client's machine; sent to clients
;;       with the "open-url" capability
;;     ("image" key width height png): a PNG, which the client keeps under
;;       key (a hash of it), sent once before it is first placed
;;     ("images" ((key row col rows cols shown) ...)): the images over the
;;       cells now, each fit in rows by cols cells from (row, col), of
;;       which the first shown rows show; to clients with the "images"
;;       capability, when they change
;;     ("voice" mode): put this client's iroh connection in voice ("on",
;;       "muted") or out ("off"), with its person's microphone and
;;       speakers; to clients with the "voice" capability (ext/voice.sls)
;;     ("result" id ok? text)  ("bye" reason)
(library (quad protocol)
  (export protocol-version
          msgpack-encode msgpack-decode encode-frame make-frame-reader
          event->message message->event)
  (import (chezscheme) (quad util) (quad event))

  ;; 2: highlights carry an underline color, and flags for underline
  ;; styles, strikethrough and overline (display.sls's face-flags: bold 1,
  ;; italic 2, underline 4, undercurl 8, dim 16, reverse 32, double
  ;; underline 64, dotted 128, dashed 256, strikethrough 512, overline 1024),
  ;; and links.
  (define protocol-version 2)

  ;; ---------------------------------------------------------------------------
  ;; MessagePack, the subset quad uses: nil and booleans (#f and #t; nil
  ;; reads as #f), integers, floats, strings (and symbols, written as
  ;; strings), binary (bytevectors), arrays (lists and vectors; read as
  ;; lists) and maps (read as association lists).

  (define (put-be p n bytes)
    (do ([i (- bytes 1) (- i 1)]) ((< i 0))
      (put-u8 p (logand (bitwise-arithmetic-shift-right n (* 8 i)) 255))))

  (define (put-length p n small-tag small-max tag8 tag16 tag32)
    (cond
     [(and small-tag (< n small-max)) (put-u8 p (+ small-tag n))]
     [(and tag8 (< n 256)) (put-u8 p tag8) (put-u8 p n)]
     [(< n 65536) (put-u8 p tag16) (put-be p n 2)]
     [else (put-u8 p tag32) (put-be p n 4)]))

  (define (encode p x)
    (cond
     [(eq? x #f) (put-u8 p #xc2)]
     [(eq? x #t) (put-u8 p #xc3)]
     [(and (integer? x) (exact? x))
      (cond
       [(<= 0 x 127) (put-u8 p x)]
       [(<= -32 x -1) (put-u8 p (+ 256 x))]
       [(<= 0 x 255) (put-u8 p #xcc) (put-u8 p x)]
       [(<= 0 x 65535) (put-u8 p #xcd) (put-be p x 2)]
       [(<= 0 x #xffffffff) (put-u8 p #xce) (put-be p x 4)]
       [(<= 0 x #xffffffffffffffff) (put-u8 p #xcf) (put-be p x 8)]
       [(<= (- (expt 2 31)) x -1) (put-u8 p #xd2) (put-be p (+ x (expt 2 32)) 4)]
       [(<= (- (expt 2 63)) x -1) (put-u8 p #xd3) (put-be p (+ x (expt 2 64)) 8)]
       [else (errorf 'msgpack-encode "integer out of range: ~s" x)])]
     [(flonum? x)
      (let ([bv (make-bytevector 8)])
        (bytevector-ieee-double-set! bv 0 x (endianness big))
        (put-u8 p #xcb)
        (put-bytevector p bv))]
     [(or (string? x) (symbol? x))
      (let ([bv (string->utf8 (if (symbol? x) (symbol->string x) x))])
        (put-length p (bytevector-length bv) #xa0 32 #xd9 #xda #xdb)
        (put-bytevector p bv))]
     [(bytevector? x)
      (put-length p (bytevector-length x) #f 0 #xc4 #xc5 #xc6)
      (put-bytevector p x)]
     [(or (list? x) (vector? x))
      (let ([l (if (vector? x) (vector->list x) x)])
        (put-length p (length l) #x90 16 #f #xdc #xdd)
        (for-each (lambda (y) (encode p y)) l))]
     [else (errorf 'msgpack-encode "cannot encode ~s" x)]))

  (define (msgpack-encode x)
    (let-values ([(p extract) (open-bytevector-output-port)])
      (encode p x)
      (extract)))

  ;; Decode the value at offset i of bv: (values value next-offset).
  (define (decode bv i)
    (define (u8 i) (bytevector-u8-ref bv i))
    (define (be i n) (let loop ([k 0] [v 0]) (if (= k n) v (loop (+ k 1) (+ (* v 256) (u8 (+ i k)))))))
    (define (signed v bits) (if (>= v (expt 2 (- bits 1))) (- v (expt 2 bits)) v))
    (define (str i n) (values (utf8->string (sub i n)) (+ i n)))
    (define (sub i n) (let ([out (make-bytevector n)]) (bytevector-copy! bv i out 0 n) out))
    (define (items i n)
      (let loop ([k 0] [i i] [acc '()])
        (if (= k n)
            (values (reverse acc) i)
            (let-values ([(x j) (decode bv i)]) (loop (+ k 1) j (cons x acc))))))
    (define (pairs i n)
      (let-values ([(l j) (items i (* 2 n))])
        (values (let loop ([l l]) (if (null? l) '() (cons (cons (car l) (cadr l)) (loop (cddr l))))) j)))
    (let ([b (u8 i)])
      (cond
       [(<= b #x7f) (values b (+ i 1))]
       [(<= #x80 b #x8f) (pairs (+ i 1) (- b #x80))]
       [(<= #x90 b #x9f) (items (+ i 1) (- b #x90))]
       [(<= #xa0 b #xbf) (str (+ i 1) (- b #xa0))]
       [(>= b #xe0) (values (- b 256) (+ i 1))]
       [else
        (case b
          [(#xc0 #xc2) (values #f (+ i 1))]
          [(#xc3) (values #t (+ i 1))]
          [(#xc4) (values (sub (+ i 2) (u8 (+ i 1))) (+ i 2 (u8 (+ i 1))))]
          [(#xc5) (let ([n (be (+ i 1) 2)]) (values (sub (+ i 3) n) (+ i 3 n)))]
          [(#xc6) (let ([n (be (+ i 1) 4)]) (values (sub (+ i 5) n) (+ i 5 n)))]
          [(#xca) (values (bytevector-ieee-single-ref bv (+ i 1) (endianness big)) (+ i 5))]
          [(#xcb) (values (bytevector-ieee-double-ref bv (+ i 1) (endianness big)) (+ i 9))]
          [(#xcc) (values (u8 (+ i 1)) (+ i 2))]
          [(#xcd) (values (be (+ i 1) 2) (+ i 3))]
          [(#xce) (values (be (+ i 1) 4) (+ i 5))]
          [(#xcf) (values (be (+ i 1) 8) (+ i 9))]
          [(#xd0) (values (signed (u8 (+ i 1)) 8) (+ i 2))]
          [(#xd1) (values (signed (be (+ i 1) 2) 16) (+ i 3))]
          [(#xd2) (values (signed (be (+ i 1) 4) 32) (+ i 5))]
          [(#xd3) (values (signed (be (+ i 1) 8) 64) (+ i 9))]
          [(#xd9) (str (+ i 2) (u8 (+ i 1)))]
          [(#xda) (str (+ i 3) (be (+ i 1) 2))]
          [(#xdb) (str (+ i 5) (be (+ i 1) 4))]
          [(#xdc) (items (+ i 3) (be (+ i 1) 2))]
          [(#xdd) (items (+ i 5) (be (+ i 1) 4))]
          [(#xde) (pairs (+ i 3) (be (+ i 1) 2))]
          [(#xdf) (pairs (+ i 5) (be (+ i 1) 4))]
          [else (errorf 'msgpack-decode "unsupported type byte #x~x" b)])])))

  (define (msgpack-decode bv)
    (let-values ([(x i) (decode bv 0)]) x))

  ;; ---------------------------------------------------------------------------
  ;; Frames

  (define (encode-frame msg)
    (let* ([payload (msgpack-encode msg)]
           [n (bytevector-length payload)]
           [out (make-bytevector (+ 4 n))])
      (bytevector-u32-set! out 0 n (endianness big))
      (bytevector-copy! payload 0 out 4 n)
      out))

  ;; A reader for a byte stream of frames: call it with each chunk read (a
  ;; bytevector and its length) and it returns the messages completed.
  (define (make-frame-reader)
    (let ([buf (make-bytevector 4096)] [len 0])
      (lambda (chunk n)
        (when (> (+ len n) (bytevector-length buf))
          (let ([new (make-bytevector (max (* 2 (bytevector-length buf)) (+ len n)))])
            (bytevector-copy! buf 0 new 0 len)
            (set! buf new)))
        (bytevector-copy! chunk 0 buf len n)
        (set! len (+ len n))
        (let loop ([start 0] [acc '()])
          (if (and (>= (- len start) 4)
                   (>= (- len start 4) (bytevector-u32-ref buf start (endianness big))))
              (let* ([size (bytevector-u32-ref buf start (endianness big))]
                     [payload (make-bytevector size)])
                (bytevector-copy! buf (+ start 4) payload 0 size)
                (loop (+ start 4 size) (cons (msgpack-decode payload) acc)))
              (begin
                (bytevector-copy! buf start buf 0 (- len start))
                (set! len (- len start))
                (reverse acc)))))))

  ;; ---------------------------------------------------------------------------
  ;; Events as messages

  (define (event->message e)
    (cond
     [(key-event? e)
      (list "key" (key-event-name e) (key-event-mods e) (key-event-text e)
            (symbol->string (key-event-kind e)))]
     [(paste-event? e) (list "paste" (paste-event-text e))]
     [(mouse-event? e)
      (list "mouse" (symbol->string (mouse-event-kind e)) (mouse-event-button e)
            (mouse-event-col e) (mouse-event-row e) (mouse-event-mods e))]
     [(clipboard-event? e) (list "clipboard" (clipboard-event-target e) (clipboard-event-text e))]
     [(focus-event? e) (list "focus" (focus-event-in? e))]
     [else (errorf 'event->message "not an event: ~s" e)]))

  ;; The event a message carries, or #f if it carries none.
  (define (message->event m)
    (let ([args (cdr m)])
      (case (string->symbol (car m))
        [(key) (make-key-event (list-ref args 0) (list-ref args 1) (list-ref args 2)
                               (string->symbol (list-ref args 3)))]
        [(paste) (make-paste-event (car args))]
        [(mouse) (make-mouse-event (string->symbol (list-ref args 0)) (list-ref args 1)
                                   (list-ref args 2) (list-ref args 3) (list-ref args 4))]
        [(clipboard) (make-clipboard-event (car args) (cadr args))]
        [(focus) (make-focus-event (car args))]
        [else #f]))))
