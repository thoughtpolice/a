;; term.sls -- the terminal, for the terminal client
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The terminal client (tui.sls) uses this to turn terminal input into events
;; and to paint what the server sends onto the screen. quad speaks the modern
;; terminal dialect when the terminal does (Ghostty, kitty, WezTerm, foot,
;; iTerm2 and others): the kitty keyboard protocol for unambiguous keys with
;; press/release events, synchronized output (mode 2026) so frames never
;; tear, SGR mouse reporting, bracketed paste, OSC 52 clipboard access,
;; focus events, cursor and pointer shapes, 24-bit color, and grapheme
;; clusters (mode 2027), so that emoji sequences take the columns the
;; editor counts for them (util.sls). It degrades to the legacy xterm
;; encodings otherwise.
(library (quad term)
  (export decode-input
          tty? tty-in-fd tty-rows tty-cols tty-kitty? tty-truecolor?
          open-tty close-tty! tty-suspend! tty-resume!
          tty-read-available! tty-pending-timeout tty-flush-pending! tty-take-resize!
          tty-paint! tty-capabilities hl-sgr)
  (import (chezscheme) (quad util) (quad kernel) (quad event))

  ;; ---------------------------------------------------------------------------
  ;; Decoding
  ;;
  ;; decode-input turns a byte list into events, returning (values events
  ;; rest) where rest is an incomplete trailing sequence to retry once more
  ;; bytes arrive. With `final?`, a lone trailing ESC is the Escape key.

  (define (utf8-length b)
    (cond [(< b #x80) 1] [(< b #xE0) 2] [(< b #xF0) 3] [else 4]))

  (define (decode-utf8 bytes n)
    (let ([bv (u8-list->bytevector (take bytes n))])
      (let ([s (utf8->string bv)])
        (if (= (string-length s) 0) #\xFFFD (string-ref s 0)))))

  (define (ctrl-byte b)
    (cond
     [(= b 13) (special-key "enter" 0 'press)]
     [(= b 10) (special-key "enter" 0 'press)]
     [(= b 9) (special-key "tab" 0 'press)]
     [(or (= b 127) (= b 8)) (special-key "backspace" 0 'press)]
     [(= b 0) (make-key-event "space" mod-ctrl #f 'press)]
     [(<= 1 b 26) (make-key-event (string (integer->char (+ 96 b))) mod-ctrl #f 'press)]
     [(= b 28) (make-key-event "\\" mod-ctrl #f 'press)]
     [(= b 29) (make-key-event "]" mod-ctrl #f 'press)]
     [(= b 30) (make-key-event "^" mod-ctrl #f 'press)]
     [(= b 31) (make-key-event "_" mod-ctrl #f 'press)]
     [else #f]))

  ;; Split "a:b;c;;d" into a list of lists of numbers (#f where empty).
  (define (csi-params s)
    (map (lambda (field)
           (map (lambda (sub) (and (> (string-length sub) 0) (string->number sub)))
                (string-split field #\:)))
         (if (string=? s "") '() (string-split s #\;))))

  (define (param ps i j default)
    (let ([f (and (< i (length ps)) (list-ref ps i))])
      (or (and f (< j (length f)) (list-ref f j)) default)))

  (define (mods-of n) (logand (- (or n 1) 1) #x0f))

  (define (kind-of n)
    (case n [(2) 'repeat] [(3) 'release] [else 'press]))

  (define tilde-keys
    '((1 . "home") (2 . "insert") (3 . "delete") (4 . "end") (5 . "pageup")
      (6 . "pagedown") (7 . "home") (8 . "end") (11 . "f1") (12 . "f2")
      (13 . "f3") (14 . "f4") (15 . "f5") (17 . "f6") (18 . "f7") (19 . "f8")
      (20 . "f9") (21 . "f10") (23 . "f11") (24 . "f12")))

  (define letter-keys
    '((#\A . "up") (#\B . "down") (#\C . "right") (#\D . "left") (#\H . "home")
      (#\F . "end") (#\P . "f1") (#\Q . "f2") (#\R . "f3") (#\S . "f4")
      (#\E . "begin")))

  ;; kitty's functional keys from the private use area that quad names.
  (define kitty-functional
    '((57399 . "0") (57400 . "1") (57401 . "2") (57402 . "3") (57403 . "4")
      (57404 . "5") (57405 . "6") (57406 . "7") (57407 . "8") (57408 . "9")
      (57409 . ".") (57410 . "/") (57411 . "*") (57412 . "-") (57413 . "+")
      (57414 . "enter") (57415 . "=") (57417 . "left") (57418 . "right")
      (57419 . "up") (57420 . "down") (57421 . "pageup") (57422 . "pagedown")
      (57423 . "home") (57424 . "end") (57425 . "insert") (57426 . "delete")))

  (define (kitty-key ps)
    (let* ([cp (param ps 0 0 0)]
           [shifted (param ps 0 1 #f)]
           [mods (mods-of (param ps 1 0 1))]
           [kind (kind-of (param ps 1 1 1))]
           [text (let ([f (and (> (length ps) 2) (list-ref ps 2))])
                   (and f (car f)
                        (list->string (map integer->char (filter values f)))))])
      (cond
       [(= cp 13) (special-key "enter" mods kind)]
       [(= cp 9) (special-key "tab" mods kind)]
       [(= cp 27) (special-key "esc" mods kind)]
       [(= cp 127) (special-key "backspace" mods kind)]
       [(= cp 8) (special-key "backspace" mods kind)]
       [(<= 57441 cp 57452) #f]           ; a modifier key on its own
       [(<= 57358 cp 57363) #f]           ; caps lock, scroll lock and kin
       [(assv cp kitty-functional)
        => (lambda (p)
             (if (= 1 (string-length (cdr p)))
                 (char-key (string-ref (cdr p) 0) mods kind)
                 (special-key (cdr p) mods kind)))]
       [(<= 57344 cp 63743) #f]
       [else
        (let* ([c (integer->char cp)]
               [c (cond
                   [(and (logtest mods mod-shift) shifted) (integer->char shifted)]
                   [(and (logtest mods mod-shift) (char-alphabetic? c)) (char-upcase c)]
                   [else c])]
               [e (char-key c mods kind)])
          (if (and text (key-event-text e) (not (char=? c #\space)))
              (make-key-event (key-event-name e) (key-event-mods e) text kind)
              e))])))

  ;; Decode one CSI sequence body (between "ESC [" and the final byte).
  (define (csi-event body final)
    (cond
     [(and (> (string-length body) 0) (char=? (string-ref body 0) #\<))
      ;; SGR mouse: < b ; x ; y, M for press and m for release.
      (let* ([ps (csi-params (substring body 1 (string-length body)))]
             [b (param ps 0 0 0)] [x (- (param ps 1 0 1) 1)] [y (- (param ps 2 0 1) 1)]
             [mods (logior (if (logtest b 4) mod-shift 0) (if (logtest b 8) mod-alt 0)
                           (if (logtest b 16) mod-ctrl 0))]
             [button (logand b 3)])
        (cond
         [(logtest b 64) (make-mouse-event (if (= button 0) 'scroll-up 'scroll-down) 0 x y mods)]
         ;; Motion: with no button held (3), the pointer moving over cells.
         [(and (logtest b 32) (= button 3)) (make-mouse-event 'move 0 x y mods)]
         [(logtest b 32) (make-mouse-event 'drag button x y mods)]
         [(char=? final #\m) (make-mouse-event 'release button x y mods)]
         [else (make-mouse-event 'press button x y mods)]))]
     [(and (> (string-length body) 0) (char=? (string-ref body 0) #\?))
      (let ([ps (csi-params (substring body 1 (string-length body)))])
        (case final
          [(#\u) (list 'kitty-flags (param ps 0 0 0))]
          [(#\c) '(device-attributes)]
          [else #f]))]
     [else
      (let ([ps (csi-params body)])
        (case final
          [(#\u) (kitty-key ps)]
          [(#\~)
           (let ([n (param ps 0 0 0)])
             (cond
              [(= n 200) 'paste-start]
              [(assv n tilde-keys)
               => (lambda (p) (special-key (cdr p) (mods-of (param ps 1 0 1))
                                           (kind-of (param ps 1 1 1))))]
              [else #f]))]
          [(#\Z) (special-key "tab" mod-shift 'press)]
          [(#\I) (make-focus-event #t)]
          [(#\O) (if (null? ps) (make-focus-event #f) #f)]
          [else
           (let ([p (assv final letter-keys)])
             (and p (special-key (cdr p) (mods-of (param ps 1 0 1))
                                 (kind-of (param ps 1 1 1)))))]))]))

  ;; Read a CSI body from `bytes` (just past "ESC ["): (values body final
  ;; rest), or #f for final when the sequence is incomplete.
  (define (scan-csi bytes)
    (let loop ([l bytes] [acc '()])
      (cond
       [(null? l) (values #f #f bytes)]
       [(<= #x40 (car l) #x7e)
        (values (list->string (map integer->char (reverse acc)))
                (integer->char (car l)) (cdr l))]
       [else (loop (cdr l) (cons (car l) acc))])))

  (define paste-end (map char->integer (string->list "\x1b;[201~")))

  ;; Split off the bracketed paste ending in ESC [ 201 ~: (values text rest)
  ;; or #f when the end has not arrived yet.
  (define (scan-paste bytes)
    (let loop ([l bytes] [acc '()])
      (cond
       [(null? l) (values #f bytes)]
       [(and (= (car l) 27)
             (let match ([l l] [p paste-end])
               (cond [(null? p) #t] [(null? l) #f]
                     [(= (car l) (car p)) (match (cdr l) (cdr p))] [else #f])))
        (values (utf8->string (u8-list->bytevector (reverse acc)))
                (drop l (length paste-end)))]
       [else (loop (cdr l) (cons (car l) acc))])))

  ;; OSC 52 ; target ; base64 -- a clipboard query's answer. Other OSC
  ;; replies are dropped.
  (define (osc-event bytes)
    (let ([s (utf8->string (u8-list->bytevector bytes))])
      (and (string-prefix? "52;" s)
           (let ([semi (string-index s #\; 3)])
             (and semi
                  (make-clipboard-event
                   (let ([t (substring s 3 semi)]) (if (string-index t #\p) "p" "c"))
                   (utf8->string (unbase64 (substring s (+ semi 1) (string-length s))))))))))

  (define (decode-input bytes final?)
    (let loop ([l bytes] [out '()])
      (define (emit e rest) (loop rest (if e (cons e out) out)))
      (cond
       [(null? l) (values (reverse out) '())]
       [(= (car l) 27)
        (let ([r (cdr l)])
          (cond
           [(null? r)
            (if final?
                (values (reverse (cons (special-key "esc" 0 'press) out)) '())
                (values (reverse out) l))]
           [(= (car r) 91)                ; [
            (let-values ([(body final rest) (scan-csi (cdr r))])
              (cond
               [(not final) (values (reverse out) l)]
               [else
                (let ([e (csi-event body final)])
                  (if (eq? e 'paste-start)
                      (let-values ([(text rest2) (scan-paste rest)])
                        (if text
                            (emit (make-paste-event text) rest2)
                            (values (reverse out) l)))
                      (emit e rest)))]))]
           [(= (car r) 93)                ; ] -- OSC, ended by BEL or ST
            (let scan ([l (cdr r)] [acc '()])
              (cond
               [(null? l) (values (reverse out) (cons 27 r))]
               [(= (car l) 7) (emit (osc-event (reverse acc)) (cdr l))]
               [(and (= (car l) 27) (pair? (cdr l)) (= (cadr l) 92))
                (emit (osc-event (reverse acc)) (cddr l))]
               [(and (= (car l) 27) (null? (cdr l))) (values (reverse out) (cons 27 r))]
               [else (scan (cdr l) (cons (car l) acc))]))]
           [(= (car r) 79)                ; O
            (cond
             [(null? (cdr r)) (values (reverse out) l)]
             [else
              (let ([p (assv (integer->char (cadr r)) letter-keys)])
                (emit (and p (special-key (cdr p) 0 'press)) (cddr r)))])]
           [else
            ;; ESC followed by a key is that key with Alt.
            (let-values ([(evs rest) (decode-input (list (car r)) #t)])
              (cond
               [(< (car r) #x80)
                (emit (and (pair? evs) (key-event? (car evs))
                           (let ([e (car evs)])
                             (make-key-event (key-event-name e)
                                             (logior mod-alt (key-event-mods e))
                                             #f 'press)))
                      (cdr r))]
               [else (emit (special-key "esc" 0 'press) r)]))]))]
       [(< (car l) 32) (emit (ctrl-byte (car l)) (cdr l))]
       [(= (car l) 127) (emit (ctrl-byte 127) (cdr l))]
       [(< (car l) 128) (emit (char-key (integer->char (car l)) 0 'press) (cdr l))]
       [else
        (let ([n (utf8-length (car l))])
          (if (< (length l) n)
              (values (reverse out) l)
              (emit (char-key (decode-utf8 l n) 0 'press) (drop l n))))])))

  ;; ---------------------------------------------------------------------------
  ;; Terminals

  (define-record-type tty
    (fields in-fd out-fd
            (mutable rows) (mutable cols)
            (mutable kitty?) truecolor?
            (mutable pending)          ; undecoded input bytes
            (mutable early)            ; events read while probing
            out                        ; output for the frame being painted
            hls                        ; highlight id -> SGR string
            links                      ; highlight id -> its hyperlink, if any
            (mutable cursor)           ; (row col shape) or #f
            (mutable in-frame?)
            (mutable last-hl)          ; the highlight the terminal has now
            (mutable link)             ; the hyperlink open now, or #f
            graphics?                  ; whether it speaks kitty's graphics protocol
            pictures                   ; image key -> (id width height), sent to it
            (mutable next-picture)))   ; the id the next image gets

  (define (write-now t s)
    (let ([bv (string->utf8 s)])
      (kernel-write (tty-out-fd t) bv (bytevector-length bv))))

  (define (refresh-size! t)
    (let ([n (kernel-tty-size (tty-out-fd t))])
      (when (> n 0)
        (tty-rows-set! t (max 2 (bitwise-arithmetic-shift-right n 16)))
        (tty-cols-set! t (max 10 (logand n #xffff))))))

  ;; Whether the window changed size since last asked; the size is updated.
  (define (tty-take-resize! t)
    (and (= 1 (kernel-take-winch)) (begin (refresh-size! t) #t)))

  (define read-buffer (make-bytevector 65536))

  (define (read-bytes t timeout-ms)
    (let ([n (kernel-read (tty-in-fd t) read-buffer (bytevector-length read-buffer) timeout-ms)])
      (cond
       [(= n -1) #f]
       [(<= n 0) '()]
       [else (let loop ([i (- n 1)] [acc '()])
               (if (< i 0) acc (loop (- i 1) (cons (bytevector-u8-ref read-buffer i) acc))))])))

  ;; Read what input is available now and decode it: a list of events, or
  ;; #f at end of input. An incomplete sequence waits for more bytes, or for
  ;; tty-flush-pending! once tty-pending-timeout passes.
  (define (tty-read-available! t)
    (let ([early (tty-early t)])
      (tty-early-set! t '())
      (let ([bytes (read-bytes t 0)])
        (and bytes
             (let-values ([(evs rest) (decode-input (append (tty-pending t) bytes) #f)])
               (tty-pending-set! t rest)
               (append early (filter event? evs)))))))

  (define (event? e) (or (key-event? e) (paste-event? e) (mouse-event? e)
                         (clipboard-event? e) (focus-event? e)))

  ;; An ESC with nothing behind it after 25ms is the Escape key.
  (define (tty-pending-timeout t) (if (pair? (tty-pending t)) 25 -1))

  (define (tty-flush-pending! t)
    (let-values ([(evs rest) (decode-input (tty-pending t) #t)])
      (tty-pending-set! t rest)
      (filter event? evs)))

  (define enter-sequence
    (string-append
     "\x1b;[?1049h"                     ; alternate screen
     "\x1b;[?2004h"                     ; bracketed paste
     "\x1b;[?1000h\x1b;[?1003h\x1b;[?1006h" ; SGR mouse, with any motion
     "\x1b;[?1004h"                     ; focus in/out
     "\x1b;[?2027h"                     ; grapheme clusters, where it can
     "\x1b;]22;text\x1b;\\"              ; the I-beam pointer
     "\x1b;[?25l"))

  (define (kitty-push t)
    ;; Disambiguate, report event types and alternate keys, report every key
    ;; as an escape code, with its text.
    (if (tty-kitty? t) "\x1b;[>31u" ""))

  (define (leave-sequence t)
    (string-append
     (if (tty-kitty? t) "\x1b;[<u" "")
     "\x1b;[0m\x1b;[?2027l\x1b;[?1004l\x1b;[?1006l\x1b;[?1003l\x1b;[?1000l\x1b;[?2004l\x1b;[0 q\x1b;]22;default\x1b;\\\x1b;[?25h\x1b;[?1049l"))

  ;; Ask whether the terminal speaks the kitty keyboard protocol: it answers
  ;; CSI ? flags u before the device attributes every terminal reports.
  (define (probe-kitty! t)
    (write-now t "\x1b;[?u\x1b;[c")
    (let loop ([tries 20] [kitty #f] [pending '()] [held '()])
      (if (= tries 0)
          (begin (tty-early-set! t (reverse held)) kitty)
          (let ([bytes (or (read-bytes t 25) '())])
            (let-values ([(evs rest) (decode-input (append pending bytes) #f)])
              (let scan ([q evs] [kitty kitty] [held held])
                (cond
                 [(null? q) (loop (- tries 1) kitty rest held)]
                 [(equal? (car q) '(device-attributes))
                  (tty-early-set! t (reverse held))
                  (tty-pending-set! t rest)
                  kitty]
                 [(and (pair? (car q)) (eq? (caar q) 'kitty-flags)) (scan (cdr q) #t held)]
                 [(event? (car q)) (scan (cdr q) kitty (cons (car q) held))]
                 [else (scan (cdr q) kitty held)])))))))

  (define (open-tty)
    ;; Every terminal quad targets has 24-bit color; QUAD_256 falls back to
    ;; the 256-color palette for the rest.
    (let ([t (make-tty 0 1 24 80 #f (not (getenv "QUAD_256")) '() '()
                       (open-output-string) (make-eqv-hashtable) (make-eqv-hashtable)
                       #f #f #f #f (kitty-graphics?) (make-hashtable string-hash string=?) 1)])
      (unless (and (= 1 (kernel-isatty 0)) (= 1 (kernel-isatty 1)))
        (errorf 'quad "standard input and output must be a terminal"))
      (kernel-tty-raw 0)
      (refresh-size! t)
      (tty-kitty?-set! t (and (not (getenv "QUAD_LEGACY_KEYS")) (probe-kitty! t)))
      (write-now t (string-append enter-sequence (kitty-push t)))
      t))

  ;; Whether the terminal draws images with kitty's graphics protocol: kitty,
  ;; ghostty and WezTerm do, by their names; tmux passes it on to none of
  ;; them. QUAD_KITTY_GRAPHICS=1 or 0 says so instead.
  (define (kitty-graphics?)
    (let ([forced (getenv "QUAD_KITTY_GRAPHICS")]
          [has (lambda (var s) (let ([v (getenv var)]) (and v (string-contains (string-downcase v) s) #t)))])
      (if forced
          (string=? forced "1")
          (and (not (getenv "TMUX"))
               (or (and (getenv "KITTY_WINDOW_ID") #t) (has "TERM" "kitty") (has "TERM" "ghostty")
                   (has "TERM_PROGRAM" "ghostty") (has "TERM_PROGRAM" "wezterm"))))))

  ;; What this terminal can do, for the server: the protocol's capabilities.
  (define (tty-capabilities t)
    (append (if (tty-kitty? t) '("release-events") '())
            (if (tty-graphics? t) '("images") '())
            '("clipboard" "primary-selection" "title" "pointer-shape" "scroll" "hidden-cursor")))

  (define (close-tty! t)
    (write-now t (leave-sequence t))
    (kernel-tty-restore 0))

  (define (tty-suspend! t)
    (close-tty! t)
    (kernel-suspend))

  (define (tty-resume! t)
    (kernel-tty-raw 0)
    (refresh-size! t)
    (write-now t (string-append enter-sequence (kitty-push t))))

  ;; ---------------------------------------------------------------------------
  ;; Painting
  ;;
  ;; tty-paint! applies one server message (see protocol.sls): highlights
  ;; are remembered, cells are written as they come, and "flush" sends the
  ;; frame in one synchronized update, with the cursor. It returns #t for a
  ;; message it handled, #f for one the client must handle itself.

  (define (color-sgr fg? c truecolor?)
    (let ([r (ash c -16)] [g (logand (ash c -8) 255)] [b (logand c 255)])
      (if truecolor?
          (format "~a;2;~a;~a;~a" (if fg? 38 48) r g b)
          (format "~a;5;~a" (if fg? 38 48) (rgb->256 r g b)))))

  (define (rgb->256 r g b)
    (let ([q (lambda (x) (cond [(< x 48) 0] [(< x 115) 1] [else (quotient (- x 35) 40)]))])
      (+ 16 (* 36 (q r)) (* 6 (q g)) (q b))))

  ;; The SGR sequence for a highlight: colors or #f, flags (see
  ;; protocol.sls), and the underline's color or #f. A modern? terminal
  ;; (one that speaks the kitty keyboard protocol: kitty, ghostty, wezterm,
  ;; foot) takes underline styles (4:n) and colors (58); others get a plain
  ;; underline.
  (define hl-sgr
    (case-lambda
     [(fg bg flags truecolor?) (hl-sgr fg bg flags truecolor? #f #f)]
     [(fg bg flags truecolor? underline-color modern?)
      (let ([style (cond [(logtest flags 4) "4"] [(not modern?) (if (logtest flags (logior 8 64 128 256)) "4" #f)]
                         [(logtest flags 8) "4:3"] [(logtest flags 64) "4:2"]
                         [(logtest flags 128) "4:4"] [(logtest flags 256) "4:5"] [else #f])])
        (string-append
         "\x1b;[0"
         (if (logtest flags 1) ";1" "")
         (if (logtest flags 16) ";2" "")
         (if (logtest flags 2) ";3" "")
         (if style (string-append ";" style) "")
         (if (logtest flags 32) ";7" "")
         (if (logtest flags 512) ";9" "")
         (if (logtest flags 1024) ";53" "")
         (if fg (string-append ";" (color-sgr #t fg truecolor?)) "")
         (if bg (string-append ";" (color-sgr #f bg truecolor?)) "")
         (if (and style underline-color modern? truecolor?)
             (format ";58:2::~a:~a:~a" (ash underline-color -16) (logand (ash underline-color -8) 255)
                     (logand underline-color 255))
             "")
         "m"))]))

  (define (frame-out t)
    (unless (tty-in-frame? t)
      (tty-in-frame?-set! t #t)
      (put-string (tty-out t) "\x1b;[?2026h\x1b;[?25l"))
    (tty-out t))

;; An OSC sequence: in the frame being painted, or at once (a pointer's
  ;; shape changes with no frame to follow).
  (define (osc t s)
    (let ([seq (string-append "\x1b;]" s "\x1b;\\")])
      (if (tty-in-frame? t) (put-string (tty-out t) seq) (write-now t seq))))

  ;; Cells written from now are hyperlink url's (OSC 8), or none for #f.
  (define (set-link! t p url)
    (unless (equal? url (tty-link t))
      (put-string p (string-append "\x1b;]8;;" (or url "") "\x1b;\\"))
      (tty-link-set! t url)))

;; Kitty's graphics protocol: an image is sent once, as PNG in base64
  ;; chunks, under an id; placing it puts it at the cursor, over c columns
  ;; (its rows follow from its shape), from x pixels into the cell, showing
  ;; its first h pixel rows.
  (define (apc p s) (put-string p (string-append "\x1b;_G" s "\x1b;\\")))

  (define (send-picture! t p key width height png)
    (unless (hashtable-contains? (tty-pictures t) key)
      (let* ([id (tty-next-picture t)] [data (base64 png)] [n (string-length data)])
        (tty-next-picture-set! t (+ id 1))
        (hashtable-set! (tty-pictures t) key (list id width height))
        (let loop ([i 0])
          (let* ([j (min n (+ i 4096))] [more (if (< j n) 1 0)])
            (apc p (string-append (if (= i 0) (format "a=t,f=100,t=d,i=~a,q=2," id) "")
                                  (format "m=~a;" more) (substring data i j)))
            (when (< j n) (loop j)))))))

  ;; A cell's size in pixels, as the terminal says, else a guess.
  (define (cell-pixels t)
    (let ([n (kernel-tty-pixels (tty-out-fd t))])
      (if (> n 0)
          (cons (max 1 (quotient (ash n -16) (tty-cols t))) (max 1 (quotient (logand n #xffff) (tty-rows t))))
          '(8 . 16))))

  ;; Replace what is placed with placements, (key row col rows cols shown)
  ;; each: an image fits its cells, keeping its shape and never growing,
  ;; centered across them and at their top, and only its first shown rows
  ;; of cells show.
  (define (place-pictures! t p placements)
    (apc p "a=d,d=a,q=2")
    (let* ([cell (cell-pixels t)] [cw (car cell)] [ch (cdr cell)])
      (for-each
       (lambda (pl)
         (let ([pic (hashtable-ref (tty-pictures t) (car pl) #f)])
           (when pic
             (let-values ([(row col rows cols shown) (apply values (cdr pl))])
               (let* ([id (car pic)] [w (cadr pic)] [h (caddr pic)]
                      [s (min 1 (/ (* cols cw) w) (/ (* rows ch) h))]
                      [dw (max 1 (round (* w s)))] [dh (max 1 (round (* h s)))]
                      [x0 (floor (/ (- (* cols cw) dw) 2))]
                      [shown-px (min dh (* shown ch))]
                      [src-h (max 1 (exact (round (/ shown-px s))))]
                      [c (max 1 (exact (round (/ dw cw))))])
                 (when (> shown 0)
                   (put-string p (format "\x1b;[~a;~aH" (+ row 1) (+ col (quotient x0 cw) 1)))
                   (apc p (format "a=p,i=~a,p=1,c=~a,X=~a,y=0,h=~a,C=1,q=2" id c (modulo x0 cw)
                                  (min h src-h)))))))))
       placements)))

  ;; A link the terminal shows: one leading outside the editor. The editor
  ;; opens file: links itself, on a ctrl-click the terminal passes on.
  (define (terminal-link url)
    (and (string? url) (not (string-prefix? "file:" url))
         (list->string (filter (lambda (c) (char>=? c #\space)) (string->list url)))))

  (define (tty-paint! t msg)
    (let ([out (lambda () (frame-out t))])
      (case (string->symbol (car msg))
        [(hl)
         ;; (id fg bg flags underline-color link); protocol 1 had neither.
         (let* ([args (cdr msg)] [id (car args)] [fg (cadr args)] [bg (caddr args)] [flags (cadddr args)]
                [more (cddddr args)]
                [underline-color (and (pair? more) (car more))]
                [link (and (pair? more) (pair? (cdr more)) (terminal-link (cadr more)))])
           (hashtable-set! (tty-hls t) id (hl-sgr fg bg flags (tty-truecolor? t) underline-color (tty-kitty? t)))
           (if link (hashtable-set! (tty-links t) id link) (hashtable-delete! (tty-links t) id)))
         #t]
        [(grid) (set-link! t (out) #f) (put-string (out) "\x1b;[0m\x1b;[2J") (tty-last-hl-set! t #f) #t]
        [(line)
         (let ([row (cadr msg)] [col (caddr msg)] [p (out)])
           (put-string p (format "\x1b;[~a;~aH" (+ row 1) (+ col 1)))
           ;; Cells are (text [hl [repeat]]): hl carries over from the cell
           ;; before, and is only sent to the terminal when it changes.
           (let loop ([cells (cadddr msg)] [hl #f])
             (unless (null? cells)
               (let* ([cell (car cells)]
                      [text (car cell)]
                      [new-hl (if (pair? (cdr cell)) (cadr cell) hl)]
                      [n (if (and (pair? (cdr cell)) (pair? (cddr cell))) (caddr cell) 1)])
                 (unless (eqv? new-hl (tty-last-hl t))
                   (put-string p (hashtable-ref (tty-hls t) new-hl "\x1b;[0m"))
                   (set-link! t p (hashtable-ref (tty-links t) new-hl #f))
                   (tty-last-hl-set! t new-hl))
                 ;; "" is the right half of a wide character, already drawn.
                 (unless (string=? text "")
                   (do ([i 0 (+ i 1)]) ((= i n)) (put-string p text)))
                 (loop (cdr cells) new-hl)))))
         #t]
        ;; The terminal moves the rows itself: a scroll region, then
        ;; scrolling up (SU) or down (SD) in it.
        [(scroll)
         (let ([top (cadr msg)] [bottom (caddr msg)] [n (cadddr msg)])
           (set-link! t (out) #f)
           (put-string (out) (format "\x1b;[0m\x1b;[~a;~ar\x1b;[~a~a\x1b;[r"
                                     (+ top 1) bottom (abs n) (if (> n 0) "S" "T")))
           (tty-last-hl-set! t #f))
         #t]
        [(cursor) (tty-cursor-set! t (and (cadr msg) (cdr msg))) #t]
        [(flush)
         (let ([p (out)] [c (tty-cursor t)])
           (set-link! t p #f)
           (put-string p "\x1b;[0m")
           (tty-last-hl-set! t #f)
           ;; A hidden cursor is still put where it is, for screen readers.
           (cond
            [(not c) (put-string p "\x1b;[?25l")]
            [(string=? (caddr c) "hidden")
             (put-string p (format "\x1b;[~a;~aH\x1b;[?25l" (+ 1 (car c)) (+ 1 (cadr c))))]
            [else
             (put-string p (format "\x1b;[~a;~aH~a\x1b;[?25h" (+ 1 (car c)) (+ 1 (cadr c))
                                   (case (string->symbol (caddr c))
                                     [(bar) "\x1b;[6 q"] [(underline) "\x1b;[4 q"] [else "\x1b;[2 q"])))])
           (put-string p "\x1b;[?2026l")
           (tty-in-frame?-set! t #f)
           (write-now t (get-output-string p)))
         #t]
        [(image)
         (when (tty-graphics? t)
           (send-picture! t (out) (cadr msg) (caddr msg) (cadddr msg) (list-ref msg 4)))
         #t]
        [(images) (when (tty-graphics? t) (place-pictures! t (out) (cadr msg))) #t]
        [(title) (osc t (string-append "2;" (cadr msg))) #t]
        [(cwd) (osc t (string-append "7;file://" (or (getenv "HOSTNAME") "") (cadr msg))) #t]
        [(pointer) (osc t (string-append "22;" (cadr msg))) #t]
        ;; OSC 52 reaches the system clipboard (target "c") or the primary
        ;; selection ("p") through the terminal, over ssh too.
        [(clipboard-set)
         (osc t (string-append "52;" (cadr msg) ";" (base64 (string->utf8 (caddr msg))))) #t]
        [(clipboard-get) (osc t (string-append "52;" (cadr msg) ";?")) #t]
        [(bell) (put-string (out) "\a") #t]
        [else #f])))

  (define base64-chars "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

  (define (unbase64 s)
    (let-values ([(out extract) (open-bytevector-output-port)])
      (let loop ([i 0] [acc 0] [bits 0])
        (when (< i (string-length s))
          (let ([v (string-index base64-chars (string-ref s i))])
            (if v
                (let ([acc (logior (ash acc 6) v)] [bits (+ bits 6)])
                  (if (>= bits 8)
                      (begin
                        (put-u8 out (logand (ash acc (- 8 bits)) 255))
                        (loop (+ i 1) (logand acc (- (ash 1 (- bits 8)) 1)) (- bits 8)))
                      (loop (+ i 1) acc bits)))
                (loop (+ i 1) acc bits)))))
      (extract)))

  (define (base64 bv)
    (let ([n (bytevector-length bv)] [out (open-output-string)])
      (let loop ([i 0])
        (when (< i n)
          (let* ([b0 (bytevector-u8-ref bv i)]
                 [b1 (if (< (+ i 1) n) (bytevector-u8-ref bv (+ i 1)) 0)]
                 [b2 (if (< (+ i 2) n) (bytevector-u8-ref bv (+ i 2)) 0)]
                 [w (logior (ash b0 16) (ash b1 8) b2)])
            (write-char (string-ref base64-chars (logand (ash w -18) 63)) out)
            (write-char (string-ref base64-chars (logand (ash w -12) 63)) out)
            (write-char (if (< (+ i 1) n) (string-ref base64-chars (logand (ash w -6) 63)) #\=) out)
            (write-char (if (< (+ i 2) n) (string-ref base64-chars (logand w 63)) #\=) out)
            (loop (+ i 3)))))
      (get-output-string out))))
