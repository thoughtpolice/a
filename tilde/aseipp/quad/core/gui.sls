;; gui.sls -- the graphical client: a window, drawn with Vulkan or Metal
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
;; (kernel/gui/): it has a thread of its own (on macOS, the main thread,
;; and Scheme has another), and its events -- keys, the mouse, a new size
;; -- come back through a mailbox the event loop polls.
;;
;; A frame is painted as rectangles -- each cell's background, and the
;; cursor -- then the cells' text, which the Rust half shapes and draws
;; from the fonts' curves (kernel/font/, kernel/font/slug.rs). Set the font
;; with the variables gui-font-family and gui-font-size, before the window
;; opens (in the init file).
(library (quad gui)
  (export gui-window gui-attach! gui-connect! frame-rects frame-cells window-message draw-frame-image
          make-painter painter-note! painter-flush!)
  (import (chezscheme) (quad util) (quad native) (quad kernel) (quad event) (quad face)
          (quad protocol) (quad grid) (quad editor) (quad commands) (quad server)
          (quad frontend))

  (define-variable gui-font-family "JetBrains Mono"
    "The font family a window draws text in: JetBrains Mono is built in; another that is not installed falls back to the system's monospace font.")
  ;; ghostty's sizes: 12 points on Linux, and 13 on macOS, whose point is
  ;; a logical pixel, smaller than Linux's (taken at 96 to the inch).
  (define-variable gui-font-size (if macos? 13 12) "The size of a window's text, in points.")
  (define-variable gui-font-features ""
    "OpenType features for a window's text, as HarfBuzz spells them, separated by spaces or commas: \"-calt\" turns off contextual alternates (and so the ligatures of fonts that make them so, as JetBrains Mono does), \"ss01\" turns on a stylistic set, \"cv05=2\" picks a character variant.")
  (define-variable gui-font-fallbacks '()
    "Font families to draw the characters a window's font lacks in, in order, before those the system suggests: a list of names, as (\"Symbols Nerd Font\" \"Noto Sans CJK JP\").")

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
  ;; The window keeps its screen a row at a time (kernel/gui/screen.rs): each
  ;; flush sends it the rows that changed, encoded as below, and the
  ;; scrolls that moved the rest. A row is rectangles -- as
  ;; kernel/render/gui.slang's Rect has them: x, y, width and height in cells
  ;; (32-bit floats), the color, 0xAARRGGBB, and the edges it reaches on to
  ;; (below), padded to 32 bytes -- and
  ;; cells, as kernel/font/cells.rs reads them: seven native u32s each -- row << 16
  ;; | column, width << 16 | attributes (the protocol's flags), the text's
  ;; color (0xAARRGGBB), what is behind it (0xRRGGBB), the underline's color
  ;; (0xAARRGGBB, alpha 0 for the text's), and where the cell's text starts
  ;; in the row's text and how long it is -- with the text, in UTF-8. A row
  ;; sent to the window is placed as if it were the top one (row and y 0).

  (define rect-bytes 32)
  (define cell-bytes 28)

  (define (put-rect! bv i x y w h color edges)
    (let ([o (* i rect-bytes)])
      (bytevector-ieee-single-native-set! bv o (inexact x))
      (bytevector-ieee-single-native-set! bv (+ o 4) (inexact y))
      (bytevector-ieee-single-native-set! bv (+ o 8) (inexact w))
      (bytevector-ieee-single-native-set! bv (+ o 12) (inexact h))
      (bytevector-u32-native-set! bv (+ o 16) (logior #xff000000 color))
      (bytevector-u32-native-set! bv (+ o 20) edges)))

  (define (rects->bytevector rects)
    (let ([bv (make-bytevector (* rect-bytes (length rects)) 0)])
      (let loop ([rs rects] [i 0])
        (unless (null? rs)
          (apply put-rect! bv i (car rs))
          (loop (cdr rs) (+ i 1))))
      bv))

  ;; A cell's background, as the terminal would show it: reverse video
  ;; swaps it with the foreground.
  (define (cell-background model hl fg bg)
    (let ([h (grid-model-hl model hl)])
      (if h
          (let ([f (car h)] [b (cadr h)] [flags (caddr h)])
            (if (logtest flags 32) (or f fg) (or b bg)))
          bg)))

  ;; The window's padding, between the grid and its edges, takes the
  ;; backgrounds of the cells along them, as ghostty's
  ;; window-padding-color = extend does, so that a bar at the edge reaches
  ;; the window's (perhaps rounded) corners: a rectangle's edges say which
  ;; of its sides reach on to the window's. A run of cells at either end of
  ;; its row reaches left or right. A run in a row with no cell in the
  ;; default background is marked edge-row, which the window makes reach up
  ;; in the top row and down in the bottom one, as it places the rows
  ;; (kernel/gui/screen.rs); a row with default cells, as text with a word
  ;; highlighted is, would have its highlights stick out of the window.
  (define edge-left 1)
  (define edge-right 2)
  (define edge-row 16)

  ;; Row `row`'s rectangles, at y: a run of cells with the same background
  ;; is one (cells in the default one need none, since the window is
  ;; cleared to it), then the cursor, if it is there.
  (define (row-rects model row y fg bg cursor)
    (let ([cols (grid-model-cols model)] [runs '()] [gap? #f] [rects '()])
      (define (add! . r) (set! rects (cons r rects)))
      (let loop ([col 0] [start 0] [color #f])
        (let ([c (and (< col cols)
                      (cell-background model (cdr (grid-model-cell model row col)) fg bg))])
          (unless (eqv? c color)
            (when color
              (if (= color bg)
                  (set! gap? #t)
                  (set! runs (cons (list start col color) runs)))))
          (when c
            (loop (+ col 1) (if (eqv? c color) start col) c))))
      (for-each (lambda (run)
                  (let-values ([(start end color) (apply values run)])
                    (add! start y (- end start) 1 color
                          (logior (if gap? 0 edge-row)
                                  (if (= start 0) edge-left 0)
                                  (if (= end cols) edge-right 0)))))
                (reverse runs))
      (when (and cursor (= (car cursor) row))
        (let ([col (cadr cursor)])
          (case (string->symbol (caddr cursor))
            [(bar) (add! col y 0.15 1 fg 0)]
            [(underline) (add! col (+ y 0.9) 1 0.1 fg 0)]
            [(hidden) (void)]
            [else (add! col y 1 1 fg 0)])))
      (reverse rects)))

  ;; Row `row`'s cells with something to draw, at row y, their text from
  ;; offset on: the cells' u32s, in a list each, and the text. Blank cells
  ;; need nothing, unless lined; the right half of a wide character is part
  ;; of the left. Reverse video and a block cursor are resolved here, so the
  ;; Rust half sees only the color to draw in.
  (define (row-cells model row y fg bg cursor offset)
    (let-values ([(port text) (open-bytevector-output-port)])
      (let ([cols (grid-model-cols model)] [cells '()])
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
                                    (not (member (caddr cursor) '("bar" "underline" "hidden"))))]
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
                  (set! cells (cons (list (logior (ash y 16) col)
                                          (logior (ash width 16) (logand flags #xffff))
                                          (logior #xff000000 color)
                                          behind
                                          (if underline (logior #xff000000 underline) 0)
                                          offset (bytevector-length bytes))
                                    cells))
                  (set! offset (+ offset (bytevector-length bytes))))))))
        (values (reverse cells) (text)))))

  (define (cells->bytevector cells)
    (let ([bv (make-bytevector (* cell-bytes (length cells)))])
      (let loop ([cs cells] [o 0])
        (unless (null? cs)
          (for-each (lambda (v i) (bytevector-u32-native-set! bv (+ o (* 4 i)) v)) (car cs) (iota 7))
          (loop (cdr cs) (+ o cell-bytes))))
      bv))

  ;; The colors of cells that leave theirs to the terminal, and the cursor.
  (define (frame-context model)
    (values (default-foreground) (default-background) (grid-model-cursor model)))

  ;; model's whole screen as rectangles, each at its row.
  (define (frame-rects model)
    (let-values ([(fg bg cursor) (frame-context model)])
      (rects->bytevector
       (apply append (map (lambda (r) (row-rects model r r fg bg cursor)) (iota (grid-model-rows model)))))))

  ;; model's whole screen as cells, each at its row, and their text.
  (define (frame-cells model)
    (let-values ([(fg bg cursor) (frame-context model)] [(port text) (open-bytevector-output-port)])
      (let loop ([r 0] [cells '()] [offset 0])
        (if (= r (grid-model-rows model))
            (values (cells->bytevector (apply append (reverse cells))) (text))
            (let-values ([(cs t) (row-cells model r r fg bg cursor offset)])
              (put-bytevector port t)
              (loop (+ r 1) (cons cs cells) (+ offset (bytevector-length t))))))))

  ;; The images placed over model's cells, as kernel/image/ reads them:
  ;; their keys, and five native u32s each -- row, column, rows, columns,
  ;; and the rows of them shown.
  (define (frame-images model)
    (let* ([images (grid-model-images model)]
           [bv (make-bytevector (* 20 (length images)))])
      (let loop ([is images] [o 0])
        (unless (null? is)
          (for-each (lambda (v i) (bytevector-u32-native-set! bv (+ o (* 4 i)) v)) (cdar is) (iota 5))
          (loop (cdr is) (+ o 20))))
      (values (map car images) bv)))

  ;; What a window has been sent of a screen, and what changed since: the
  ;; rows to send at the next flush, the scrolls before them (newest
  ;; first), whether every row goes, and the cursor and colors the window
  ;; last drew with.
  (define-record-type painter
    (fields (mutable dirty) (mutable scrolls) (mutable whole?) (mutable cursor) (mutable colors))
    (protocol (lambda (new) (lambda () (new (make-eqv-hashtable) '() #t #f #f)))))

  ;; A message, which model has taken: what it changes.
  (define (painter-note! p model msg)
    (case (string->symbol (car msg))
      [(grid) (painter-whole?-set! p #t)]
      [(line) (hashtable-set! (painter-dirty p) (cadr msg) #t)]
      [(scroll)
       ;; The window moves its rows; rows still to send move with them,
       ;; and so does the cell the cursor was drawn on.
       (let* ([top (cadr msg)] [bottom (caddr msg)] [n (cadddr msg)]
              [moved (lambda (r) (if (and (<= top r) (< r bottom)) (- r n) r))]
              [dirty (make-eqv-hashtable)])
         (vector-for-each
          (lambda (r)
            (let ([to (moved r)])
              (when (or (< r top) (>= r bottom) (and (<= top to) (< to bottom)))
                (hashtable-set! dirty to #t))))
          (hashtable-keys (painter-dirty p)))
         (painter-dirty-set! p dirty)
         (let ([c (painter-cursor p)])
           (when c (painter-cursor-set! p (cons (moved (car c)) (cdr c)))))
         (painter-scrolls-set! p (cons (list top bottom n) (painter-scrolls p))))]
      [else (void)]))

  ;; What changed in model's screen since the last flush, as gui-frame
  ;; takes it, handed to (paint rows whole? scrolls index rects cells text
  ;; background foreground cursor-row cursor-col image-keys image-places).
  (define (painter-flush! p model paint)
    (let-values ([(fg bg cursor) (frame-context model)])
      (let ([dirty (painter-dirty p)] [rows (grid-model-rows model)])
        (unless (equal? (painter-colors p) (cons fg bg)) (painter-whole?-set! p #t))
        ;; The cursor is drawn in its row: where it was, and where it is.
        (unless (equal? cursor (painter-cursor p))
          (for-each (lambda (c) (when c (hashtable-set! dirty (car c) #t))) (list cursor (painter-cursor p))))
        (let* ([whole? (painter-whole? p)]
               [sent (if whole?
                         (iota rows)
                         (filter (lambda (r) (< -1 r rows)) (sort < (vector->list (hashtable-keys dirty)))))]
               [encoded (map (lambda (r)
                               (let-values ([(cells text) (row-cells model r 0 fg bg cursor 0)])
                                 (list r (row-rects model r 0 fg bg cursor) cells text)))
                             sent)]
               [index (let ([bv (make-bytevector (* 16 (length encoded)))])
                        (let loop ([es encoded] [o 0])
                          (unless (null? es)
                            (let ([e (car es)])
                              (for-each (lambda (v i) (bytevector-u32-native-set! bv (+ o (* 4 i)) v))
                                        (list (car e) (length (cadr e)) (length (caddr e))
                                              (bytevector-length (cadddr e)))
                                        (iota 4)))
                            (loop (cdr es) (+ o 16))))
                        bv)]
               [scrolls (let* ([ss (reverse (painter-scrolls p))] [bv (make-bytevector (* 12 (length ss)))])
                          (let loop ([ss ss] [o 0])
                            (unless (null? ss)
                              (for-each (lambda (v i) (bytevector-s32-native-set! bv (+ o (* 4 i)) v))
                                        (car ss) (iota 3))
                              (loop (cdr ss) (+ o 12))))
                          bv)]
               [text (let-values ([(port extract) (open-bytevector-output-port)])
                       (for-each (lambda (e) (put-bytevector port (cadddr e))) encoded)
                       (extract))])
          (let-values ([(keys places) (frame-images model)])
            (paint rows whole? (if whole? (make-bytevector 0) scrolls) index
                   (rects->bytevector (apply append (map cadr encoded)))
                   (cells->bytevector (apply append (map caddr encoded)))
                   text bg fg (if cursor (car cursor) -1) (if cursor (cadr cursor) -1) keys places))))
      (painter-dirty-set! p (make-eqv-hashtable))
      (painter-scrolls-set! p '())
      (painter-whole?-set! p #f)
      (painter-cursor-set! p cursor)
      (painter-colors-set! p (cons fg bg))))

  ;; A window's screen: the cells it shows, and what it was sent of them.
  (define-record-type screen
    (fields model painter)
    (protocol (lambda (new) (lambda () (new (make-grid-model) (make-painter))))))

  ;; model's screen drawn as a window would draw it, but with no window, by
  ;; h (gui-headless): its width and height in pixels, and its pixels
  ;; (RGBA, top row first). Tests look at frames so, on a GPU or a software
  ;; renderer; images it places must have been given h first
  ;; (gui-headless-image!). With a painter (that has noted model's
  ;; messages), only what changed since it last drew goes to h.
  (define draw-frame-image
    (case-lambda
     [(h model) (draw-frame-image h model (make-painter))]
     [(h model p)
      (let* ([info (gui-headless-info h)]
             [width (* (grid-model-cols model) (string->number (car info)))]
             [height (* (grid-model-rows model) (string->number (cadr info)))]
             [pixels #f])
        (painter-flush! p model
                        (lambda args (set! pixels (gui-headless-draw! h (grid-model-cols model) (apply gui-frame args)))))
        (values width height pixels))]))

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
  ;; none can open (no display, no Vulkan or Metal 4, no fonts).
  (define (gui-window)
    (apply gui-open "quad" initial-cols initial-rows (client-font #f)))

  ;; What a window can do, for the server: the protocol's capabilities.
  (define (gui-capabilities win)
    (append '("title" "font" "pointer-shape" "scroll" "images" "hidden-cursor" "voice")
            (if (gui-clipboard? win) '("clipboard") '())
            (if (gui-primary-selection? win) '("primary-selection") '())
            (frontend-capabilities)))

  ;; Handle a message from the server: the screen's go into the model,
  ;; which is painted at each flush; others are extensions' (frontend.sls),
  ;; with fd the server's stream (#f in its process) and send to answer
  ;; on it. Returns #f when the server said goodbye.
  (define (paint! win screen fd msg send)
    (let ([model (screen-model screen)])
      (case (string->symbol (car msg))
        [(grid line hl cursor scroll images)
         (grid-model-apply! model msg)
         (painter-note! (screen-painter screen) model msg)
         #t]
        [(image) (gui-image! win (cadr msg) (list-ref msg 4)) #t]
        [(flush)
         (grid-model-apply! model msg)
         (painter-flush! (screen-painter screen) model
                         (lambda args (gui-paint! win (apply gui-frame args))))
         #t]
        [(title) (gui-set-title! win (cadr msg)) #t]
        [(font) (apply gui-set-font! win (font-spec (cdr msg))) #t]
        [(pointer) (gui-set-pointer! win (cadr msg)) #t]
        ;; The system clipboard ("c") and primary selection ("p"): the
        ;; contents come back as a "clipboard" event (window-message).
        [(clipboard-set) (gui-clipboard-set! win (cadr msg) (caddr msg)) #t]
        [(clipboard-get) (gui-clipboard-get! win (cadr msg)) #t]
        [(bye) #f]
        [else (frontend-handle! fd msg send) #t])))

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
  ;; The editor tells each window its font ("font" family points features
  ;; fallbacks): the variables gui-font-family, gui-font-size,
  ;; gui-font-features and gui-font-fallbacks, as they change, and each
  ;; window's own size once it is zoomed (ctrl+= and ctrl+-, ctrl+0 to
  ;; follow gui-font-size again).

  ;; Client c's font (#f: a new window's).
  (define (client-font c)
    (list (get-var 'gui-font-family)
          (or (and c (client-local c 'gui-font-size #f)) (get-var 'gui-font-size))
          (let ([f (get-var 'gui-font-features)]) (if (string? f) f ""))
          (let ([f (get-var 'gui-font-fallbacks)])
            (if (list? f) (filter string? f) '()))))

  ;; A "font" message's fields, those an older editor leaves out filled in.
  (define (font-spec fields)
    (let ([n (length fields)])
      (list (car fields) (cadr fields)
            (if (> n 2) (caddr fields) "")
            (if (> n 3) (cadddr fields) '()))))

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
                (when (memq name '(gui-font-family gui-font-size gui-font-features gui-font-fallbacks))
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
    (let* ([screen (make-screen)]
           [client #f]
           [src #f]
           [close (lambda ()
                    (remove-source! src)
                    (gui-close! win)
                    ;; The editor runs while it has clients (another window,
                    ;; a terminal), or is a daemon.
                    (when (and (null? (clients)) (not (editor-daemon?))) (editor-stop!)))]
           ;; Input goes to the editor this window shows: this one, or
           ;; another it is diverted to (frontend.sls).
           [paint (lambda (msg) (paint! win screen #f msg (lambda (m) (deliver! client m))))])
      (set! client (frontend-connect! "gui" initial-rows initial-cols (gui-capabilities win)
                                      paint close))
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
    (let* ([screen (make-screen)]
           [send (frame-sender fd)]
           [reader (make-frame-reader)]
           [lost? #f])                  ; the editor went without a goodbye
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
                         (let ([got (kernel-read-some fd 0)])
                           (unless got (set! lost? #t))
                           (and got
                                (for-all (lambda (msg)
                                           (paint! win screen fd msg send))
                                         (reader got (bytevector-length got)))))))])
          (if (and continue? (not (kernel-stop-requested?)))
              (loop)
              (begin
                (guard (e [#t (void)]) (send '("detach")))
                (gui-close! win)
                (kernel-close fd)
                (lost-editor lost?))))))))
