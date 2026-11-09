;; gui.sls -- the graphical client: a window, drawn with Vulkan
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A window is a client like a terminal (tui.sls): the server draws its
;; frames as cells, and the window draws the cells, so what the editor
;; shows looks the same in both. It runs either in the server's process
;; (gui-attach!) or in a process of its own (gui-connect!), connected to
;; an editor elsewhere, over a socket or iroh; either way it keeps the
;; cells in a grid model (grid.sls) and paints each frame as it is
;; flushed. The window itself is the Rust half's
;; (kernel/gui.rs): it has a thread of its own, and its events -- keys, the
;; mouse, a new size -- come back through a mailbox the event loop polls.
;;
;; A frame is painted as rectangles -- each cell's background, and the
;; cursor -- then the cells' text, which the Rust half shapes and draws
;; from the fonts' curves (kernel/font.rs, kernel/slug.rs). Set the font
;; with the variables gui-font-family and gui-font-size, before the window
;; opens (in the init file).
(library (quad gui)
  (export gui-window gui-attach! gui-connect! frame-rects frame-cells window-message draw-frame-image)
  (import (chezscheme) (quad util) (quad native) (quad kernel) (quad event) (quad face)
          (quad protocol) (quad grid) (quad editor) (quad commands) (quad server) (quad relay)
          (quad link))

  (define-variable gui-font-family "JetBrains Mono"
    "The font family a window draws text in: JetBrains Mono is built in; another that is not installed falls back to the system's monospace font.")
  (define-variable gui-font-size 12 "The size of a window's text, in points.")

  ;; The size a window opens at, in cells; it reports its real size once
  ;; it is up.
  (define initial-cols 100)
  (define initial-rows 32)

  ;; The colors of cells that leave theirs to the "terminal": the theme's
  ;; text and background, else ghostty's defaults.
  (define (default-foreground) (or (face-fg (face-ref 'ui.text)) #xffffff))
  (define (default-background) (or (face-bg (face-ref 'ui.background)) #x282c34))

  ;; ---------------------------------------------------------------------------
  ;; Painting
  ;;
  ;; A frame is a bytevector of rectangles, as kernel/gui.slang's Rect has
  ;; them: x, y, width and height in cells (32-bit floats), then the color,
  ;; 0xAARRGGBB, padded to 32 bytes.

  (define rect-bytes 32)

  (define (put-rect! bv i x y w h color)
    (let ([o (* i rect-bytes)])
      (bytevector-ieee-single-native-set! bv o (inexact x))
      (bytevector-ieee-single-native-set! bv (+ o 4) (inexact y))
      (bytevector-ieee-single-native-set! bv (+ o 8) (inexact w))
      (bytevector-ieee-single-native-set! bv (+ o 12) (inexact h))
      (bytevector-u32-native-set! bv (+ o 16) (logior #xff000000 color))))

  ;; A cell's background, as the terminal would show it: reverse video
  ;; swaps it with the foreground.
  (define (cell-background model hl fg bg)
    (let ([h (grid-model-hl model hl)])
      (if h
          (let ([f (car h)] [b (cadr h)] [flags (caddr h)])
            (if (logtest flags 32) (or f fg) (or b bg)))
          bg)))

  ;; The rectangles to paint for model's screen: a run of cells with the
  ;; same background is one rectangle (cells in the default one need none,
  ;; since the window is cleared to it), then the cursor on top.
  (define (frame-rects model)
    (let ([fg (default-foreground)] [bg (default-background)] [rects '()])
      (define (add! . r) (set! rects (cons r rects)))
      (do ([row 0 (+ row 1)]) ((= row (grid-model-rows model)))
        (let loop ([col 0] [start 0] [color #f])
          (let ([c (and (< col (grid-model-cols model))
                        (cell-background model (cdr (grid-model-cell model row col)) fg bg))])
            (unless (eqv? c color)
              (when (and color (not (= color bg)))
                (add! start row (- col start) 1 color)))
            (when c
              (loop (+ col 1) (if (eqv? c color) start col) c)))))
      (let ([cursor (grid-model-cursor model)])
        (when cursor
          (let ([row (car cursor)] [col (cadr cursor)])
            (case (string->symbol (caddr cursor))
              [(bar) (add! col row 0.15 1 fg)]
              [(underline) (add! col (+ row 0.9) 1 0.1 fg)]
              [else (add! col row 1 1 fg)]))))
      (let* ([rects (reverse rects)] [bv (make-bytevector (* rect-bytes (length rects)) 0)])
        (let loop ([rs rects] [i 0])
          (unless (null? rs)
            (apply put-rect! bv i (car rs))
            (loop (cdr rs) (+ i 1))))
        bv)))

  ;; The cells with something to draw, as kernel/font.rs reads them: seven
  ;; native u32s each -- row << 16 | column, width << 16 | attributes (the
  ;; protocol's flags), the text's color (0xAARRGGBB), what is behind it
  ;; (0xRRGGBB), the underline's color (0xAARRGGBB, alpha 0 for the
  ;; text's), and where the cell's text starts in the text and how long it
  ;; is -- and the text, in UTF-8. Blank cells need nothing,
  ;; unless underlined; the right half of a wide character is part of the
  ;; left. Reverse video and a block cursor are resolved here, so the Rust
  ;; half sees only the color to draw in.
  (define (frame-cells model)
    (let-values ([(port text) (open-bytevector-output-port)])
      (let ([fg (default-foreground)] [bg (default-background)]
            [cursor (grid-model-cursor model)]
            [rows (grid-model-rows model)] [cols (grid-model-cols model)]
            [cells '()] [offset 0])
        (do ([row 0 (+ row 1)]) ((= row rows))
          (do ([col 0 (+ col 1)]) ((= col cols))
            (let* ([cell (grid-model-cell model row col)] [s (car cell)]
                   [h (grid-model-hl model (cdr cell))])
              (let ([f (and h (car h))] [b (and h (cadr h))] [flags (if h (caddr h) 0)]
                    [underline (and h (pair? (cdddr h)) (cadddr h))])
                ;; Blank cells draw nothing, unless lined: underlined,
                ;; struck through or overlined.
                (unless (or (string=? s "")
                            (and (string=? s " ") (not (logtest flags (logior 4 8 64 128 256 512 1024)))))
                  (let* ([block? (and cursor (= (car cursor) row) (= (cadr cursor) col)
                                      (not (member (caddr cursor) '("bar" "underline"))))]
                         [behind (if block? fg (cell-background model (cdr cell) fg bg))]
                         [color (cond
                                 ;; Under a block cursor, text takes the
                                 ;; background's color, as ghostty draws it.
                                 [block? (cell-background model (cdr cell) fg bg)]
                                 [(logtest flags 32) (or b bg)]
                                 [else (or f fg)])]
                        [bytes (string->utf8 s)]
                        [width (if (and (< (+ col 1) cols)
                                        (string=? (car (grid-model-cell model row (+ col 1))) ""))
                                   2 1)])
                    (put-bytevector port bytes)
                    (set! cells (cons (list (logior (ash row 16) col)
                                            (logior (ash width 16) (logand flags #xffff))
                                            (logior #xff000000 color)
                                            behind
                                            (if underline (logior #xff000000 underline) 0)
                                            offset (bytevector-length bytes))
                                      cells))
                    (set! offset (+ offset (bytevector-length bytes)))))))))
        (let ([bv (make-bytevector (* 28 (length cells)))])
          (let loop ([cs (reverse cells)] [o 0])
            (unless (null? cs)
              (for-each (lambda (v i) (bytevector-u32-native-set! bv (+ o (* 4 i)) v)) (car cs) (iota 7))
              (loop (cdr cs) (+ o 28))))
          (values bv (text))))))

  ;; model's screen drawn as a window would draw it, but with no window, by
  ;; h (gui-headless): its width and height in pixels, and its pixels
  ;; (RGBA, top row first). Tests look at frames so, on a GPU or a software
  ;; renderer.
  (define (draw-frame-image h model)
    (let-values ([(cells text) (frame-cells model)])
      (let* ([info (gui-headless-info h)]
             [width (* (grid-model-cols model) (string->number (car info)))]
             [height (* (grid-model-rows model) (string->number (cadr info)))])
        (values width height
                (gui-headless-draw! h (frame-rects model) cells text (default-background)
                                    (grid-model-cols model) (grid-model-rows model))))))

  ;; ---------------------------------------------------------------------------
  ;; Events

  ;; The protocol message for an event from the window, or #f.
  (define (window-message msg)
    (case (string->symbol (car msg))
      [(char)
       (let-values ([(text mods kind) (apply values (cdr msg))])
         (event->message (char-key (string-ref text 0) mods (string->symbol kind))))]
      [(special)
       (let-values ([(name mods kind) (apply values (cdr msg))])
         (event->message (special-key name mods (string->symbol kind))))]
      ;; These are protocol messages already.
      [(resize mouse focus clipboard) msg]
      ;; A file dropped on the window is opened.
      [(dropped) (list "open" (cadr msg) #f)]
      [else #f]))

  ;; ---------------------------------------------------------------------------
  ;; The window

  ;; A window to edit in, for gui-attach! or gui-connect!: an error where
  ;; none can open (no display, no Vulkan, no fonts).
  (define (gui-window)
    (gui-open "quad" initial-cols initial-rows (get-var 'gui-font-family) (get-var 'gui-font-size)))

  ;; What a window can do, for the server: the protocol's capabilities.
  (define (gui-capabilities win)
    (append '("title" "font" "pointer-shape" "scroll")
            (if (gui-clipboard? win) '("clipboard" "primary-selection") '())
            (if (can-open-urls?) '("open-url") '())))

  ;; Handle a message from the server: the screen's go into the model,
  ;; which is painted at each flush. Returns #f when the server said
  ;; goodbye.
  (define (paint! win model msg)
    (case (string->symbol (car msg))
      [(grid line hl cursor scroll) (grid-model-apply! model msg) #t]
      [(flush)
       (grid-model-apply! model msg)
       (let-values ([(cells text) (frame-cells model)])
         (let ([cursor (or (grid-model-cursor model) '(-1 -1))])
           (gui-paint! win (frame-rects model) cells text (default-background) (default-foreground)
                       (car cursor) (cadr cursor))))
       #t]
      [(title) (gui-set-title! win (cadr msg)) #t]
      [(font) (gui-set-font! win (cadr msg) (caddr msg)) #t]
      [(pointer) (gui-set-pointer! win (cadr msg)) #t]
      ;; The system clipboard ("c") and primary selection ("p"): the
      ;; contents come back as a "clipboard" event (window-message).
      [(clipboard-set) (gui-clipboard-set! win (cadr msg) (caddr msg)) #t]
      [(clipboard-get) (gui-clipboard-get! win (cadr msg)) #t]
      [(open-url) (open-url-here! (cadr msg)) #t]
      [(bye) #f]
      [else #t]))

  ;; Handle the window's events: send (as protocol messages) what are the
  ;; editor's, and report what went wrong. Returns #f once it is closed.
  (define (window-events! win send report)
    (let loop ([msgs (gui-take! win)] [open? #t])
      (if (null? msgs)
          open?
          (let ([msg (car msgs)])
            (case (string->symbol (car msg))
              [(error) (report (cadr msg)) (loop (cdr msgs) open?)]
              [(closed) (loop (cdr msgs) #f)]
              [else
               (let ([m (window-message msg)])
                 (when m (send m)))
               (loop (cdr msgs) open?)])))))

  (define (report-to-stderr text) (fprintf (current-error-port) "quad: ~a\n" text))

  ;; ---------------------------------------------------------------------------
  ;; Fonts
  ;;
  ;; The editor tells each window its font ("font" family points): the
  ;; variables gui-font-family and gui-font-size, as they change, and each
  ;; window's own size once it is zoomed (ctrl+= and ctrl+-, ctrl+0 to
  ;; follow gui-font-size again).

  (define (client-font c)
    (list (get-var 'gui-font-family)
          (or (client-local c 'gui-font-size #f) (get-var 'gui-font-size))))

  (define (send-font! c)
    (when (client-has? c "font") (client-send! c (cons "font" (client-font c)))))

  ;; Zoom the current client's window by step points, or back to
  ;; gui-font-size (step #f).
  (define (zoom! step)
    (let ([c (current-client)])
      (if (not (client-has? c "font"))
          (message "Only a window has a font to zoom")
          (begin
            (client-local-set! c 'gui-font-size
                               (and step (max 4 (min 96 (+ (cadr (client-font c)) step)))))
            (send-font! c)
            (message "Font: ~a points" (cadr (client-font c)))))))

  (at-load
   (add-hook! 'client-attach-hook send-font!)
   (add-hook! 'variable-change-hook
              (lambda (name v)
                (when (memq name '(gui-font-family gui-font-size))
                  (for-each send-font! (clients)))))
   (define-command 'zoom-in "Make the window's text larger" (lambda () (zoom! 1)))
   (define-command 'zoom-out "Make the window's text smaller" (lambda () (zoom! -1)))
   (define-command 'zoom-reset "Size the window's text as gui-font-size says" (lambda () (zoom! #f)))
   (define-key global-keymap "ctrl+=" 'zoom-in "Zoom In")
   (define-key global-keymap "ctrl++" 'zoom-in "Zoom In")
   (define-key global-keymap "ctrl+-" 'zoom-out "Zoom Out")
   (define-key global-keymap "ctrl+0" 'zoom-reset "Zoom Reset")
   (define-command 'new-window "Open another window onto this editor"
     (lambda ()
       (guard (e [#t (message-error "No window: ~a" (condition->string e))])
         (gui-attach! (gui-window)))))
   (define-key (keymap-lookup-target space-keymap "j") "w" 'new-window "New Window"))

  ;; ---------------------------------------------------------------------------
  ;; In the server's process

    ;; Connect window win (gui-window) to this process's server, as a source
  ;; in its loop. Returns the client.
  (define (gui-attach! win)
    (let* ([model (make-grid-model)]
           [client #f]
           [src #f]
           [close (lambda ()
                    (remove-source! src)
                    (gui-close! win)
                    ;; The editor runs while it has clients (another window,
                    ;; a terminal), or is a daemon.
                    (when (and (null? (clients)) (not (editor-daemon?))) (editor-stop!)))]
           ;; Messages go to the editor this window shows: this one, or
           ;; another it has switched to (relay.sls).
           [paint (lambda (msg) (paint! win model msg))])
      (set! client (server-connect! "gui" initial-rows initial-cols (gui-capabilities win)
                                    (frontend-sender (lambda () client) paint) close))
      (frontend! client paint)
      (set-client-user! client (default-user-name))
      (set! src
            (watch-fd! (gui-fd win)
                       (lambda ()
                         (unless (window-events!
                                  win
                                  (lambda (m) (deliver! client m))
                                  (lambda (text)
                                    (report-to-stderr text)
                                    (with-client client (lambda () (message-error "~a" text)))))
                           (remove-client! client)))))
      client))

  ;; ---------------------------------------------------------------------------
  ;; In a process of its own

  ;; Make window win (gui-window) a client of the editor on descriptor fd
  ;; (connected already: a socket, or an iroh stream), open `files` there,
  ;; and run until the editor says goodbye or the window closes. Returns the
  ;; exit status.
  (define (gui-connect! win fd files line)
    (let* ([model (make-grid-model)]
           [send (frame-sender fd)]
           [reader (make-frame-reader)]
           [buf (make-bytevector 65536)])
      (send (list "hello" protocol-version "gui" initial-rows initial-cols (gui-capabilities win)))
      (send (list "user" (default-user-name)))
      ;; Paths are the editor's to open, so they go absolute.
      (for-each (lambda (f)
                  (send (list "open" (if (string-prefix? "/" f) f (path-join (current-directory) f)) line)))
                files)
      (let loop ()
        (let* ([ready (kernel-poll (list (gui-fd win) fd) -1)]
               [continue?
                (and (or (not (memv (gui-fd win) ready))
                         (window-events! win send report-to-stderr))
                     (or (not (memv fd ready))
                         (let ([n (kernel-read fd buf (bytevector-length buf) 0)])
                           (and (> n -1)
                                (for-all (lambda (msg) (paint! win model msg)) (reader buf n))))))])
          (if continue?
              (loop)
              (begin
                (guard (e [#t (void)]) (send '("detach")))
                (gui-close! win)
                (kernel-close fd)
                0)))))))
