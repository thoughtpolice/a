;; prompt.sls -- prompts and pickers, popups, layers and jumps, where a view is drawn
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; What a client shows over its view and asks of its person -- prompts,
;; pickers, dialogs and menus, popups, the active layer and its legend,
;; jump labels -- and where its view was last drawn, for the mouse; the
;; editor core's third layer (see editor.sls).
(library (quad prompt)
  (export
          make-prompt prompt? prompt-label prompt-input prompt-input-set! prompt-cursor
          prompt-cursor-set! prompt-candidates prompt-items prompt-items-set! prompt-index
          prompt-index-set! prompt-on-accept prompt-on-change prompt-style prompt-hint
          prompt-on-select-set! prompt-on-cancel-set! prompt-selected! cancel-prompt!
          prompt-most prompt-most-set! current-prompt prompt-refresh! prompt-edit! open-prompt!
          close-prompt! prompt-accept! read-string-prompt read-string-dialog pick make-popup
          popup? popup-title popup-lines popup-footer current-popup show-popup! hide-popup!
          active-layer active-layer-keymap exit-layer! enter-layer! layer-legend-visible?
          idle-timeout jump-labels jump-callback jump-labels-set! view-geometry
          view-geometry-set! cluster grapheme-after grapheme-before display-column
          screen->position unfiltered unfiltered?
          make-overlay overlay? overlay-name overlay-place overlay-widget overlay-key
          make-area area? area-rows area-cols area-top area-bottom area-cursor
          client-overlays show-overlay! hide-overlay! key-overlay)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad client) (quad keymap))

  ;; ---------------------------------------------------------------------------
  ;; Prompts and pickers
  ;;
  ;; A prompt reads a line in the bottom row. Given a candidates procedure
  ;; it is a picker: candidates are (display . value) pairs, fuzzy-filtered
  ;; by the input; style 'picker draws them in a centered floating window.
  ;; Style 'dialog reads text in a centered window instead, as a form's text
  ;; box would: the label is its title, the input wraps and the box grows
  ;; with it, and hint, if any, shows while the input is empty. Style
  ;; 'secret is a dialog that shows bullets for what is typed. A picker's
  ;; hint, if any, is shown above its query: the question it asks. Style
  ;; 'menu shows the candidates in a small window at the cursor, as
  ;; completions; its on-change typically puts the input in the text.

  (define-record-type prompt
    (fields label (mutable input) (mutable cursor) candidates
            (mutable items) (mutable index) on-accept on-change style hint
            (mutable most)              ; the most items it has had, for its size
            ;; (on-select value) whenever another candidate is selected, as
            ;; a theme picker shows each; (on-cancel) if it is cancelled.
            (mutable on-select) (mutable on-cancel)
            (mutable last))             ; (value) last selected, for on-select
    (protocol
     (lambda (new)
       (case-lambda
        [(label initial candidates on-accept on-change style)
         (new label initial (string-length initial) candidates '() 0 on-accept on-change style #f 0 #f #f #f)]
        [(label initial candidates on-accept on-change style hint)
         (new label initial (string-length initial) candidates '() 0 on-accept on-change style hint 0 #f #f #f)]))))

  ;; Tell the prompt's on-select of the candidate selected now, if it has
  ;; changed.
  (define (prompt-selected! p)
    (when (prompt-on-select p)
      (let ([items (prompt-items p)])
        (when (pair? items)
          (let ([v (cdr (car (list-ref items (prompt-index p))))])
            (unless (and (prompt-last p) (equal? (car (prompt-last p)) v))
              (prompt-last-set! p (list v))
              ((prompt-on-select p) v)))))))

  (define (current-prompt) (and (current-client) (client-prompt (current-client))))

  ;; Candidates as a procedure gives them, not filtered by the input: they
  ;; are what it asks for already (the lines a search finds, say).
  (define-record-type (unfiltered-candidates unfiltered unfiltered?) (fields procedure))

  (define (candidates-of p input)
    (let ([c (prompt-candidates p)])
      (if (unfiltered? c) ((unfiltered-candidates-procedure c) input) (c input))))

  (define (prompt-refresh! p)
    (when (prompt-candidates p)
      (let* ([input (prompt-input p)]
             [all (candidates-of p input)]
             ;; (candidate . matched-indices) each, best first.
             [items (if (or (string=? input "") (unfiltered? (prompt-candidates p)))
                        (map (lambda (c) (cons c '())) all)
                        (map cdr
                             (sort (lambda (a b) (> (car a) (car b)))
                                   (filter-map (lambda (c)
                                                 (let ([s (fuzzy-score input (car c))])
                                                   (and s (cons (car s) (cons c (cdr s))))))
                                               all))))]
             [n (length items)])
        (prompt-items-set! p items)
        (prompt-most-set! p (max (prompt-most p) n))
        (prompt-index-set! p (clamp (prompt-index p) 0 (max 0 (- n 1))))
        (prompt-selected! p)))
    (when (prompt-on-change p) ((prompt-on-change p) (prompt-input p))))

  ;; Edit the current prompt's input: (f input cursor) gives the new input
  ;; and cursor, which the candidates are then chosen again for.
  (define (prompt-edit! f)
    (let ([p (current-prompt)])
      (when p
        (let-values ([(in c) (f (prompt-input p) (prompt-cursor p))])
          (prompt-input-set! p in)
          (prompt-cursor-set! p (clamp c 0 (string-length in)))
          (prompt-index-set! p 0)
          (prompt-refresh! p)))))

  ;; Show prompt p; it is returned.
  (define (open-prompt! p)
    (client-prompt-set! (current-client) p)
    (prompt-refresh! p)
    p)

  ;; Cancel the prompt: it goes, and its on-cancel runs.
  (define (cancel-prompt!)
    (let ([p (current-prompt)])
      (close-prompt!)
      (when (and p (prompt-on-cancel p)) ((prompt-on-cancel p)))))

  (define (close-prompt!) (client-prompt-set! (current-client) #f))

  (define (prompt-accept! p)
    (close-prompt!)
    (let ([items (prompt-items p)])
      (if (prompt-candidates p)
          (if (pair? items)
              ((prompt-on-accept p) (cdr (car (list-ref items (prompt-index p)))))
              ((prompt-on-accept p) (prompt-input p)))
          ((prompt-on-accept p) (prompt-input p)))))

  (define read-string-prompt
    (case-lambda
     [(label k) (read-string-prompt label "" k)]
     [(label initial k) (open-prompt! (make-prompt label initial #f k #f 'line))]))

  ;; Read text in a centered window titled title, then call (k text). hint
  ;; (a string or #f) says what to write. A secret's text is not shown.
  (define read-string-dialog
    (case-lambda
     [(title hint k) (read-string-dialog title hint "" k)]
     [(title hint initial k) (read-string-dialog title hint initial k #f)]
     [(title hint initial k secret?)
      (open-prompt! (make-prompt title initial #f k #f (if secret? 'secret 'dialog) hint))]))

  ;; Pick among candidates, a list or a procedure from the input to a list,
  ;; of (display . value) pairs, then call (k value).
  (define pick
    (case-lambda
     [(label candidates k) (pick label candidates k 'picker)]
     [(label candidates k style) (pick label candidates k style #f)]
     [(label candidates k style hint)
      (open-prompt! (make-prompt label "" (if (procedure? candidates) candidates (lambda (_) candidates))
                                 k #f style hint))]))

  ;; ---------------------------------------------------------------------------
  ;; Overlays
  ;;
  ;; An overlay floats over a client's panes: a widget (widget.sls), where
  ;; it goes, and what it does with keys. (place area) gives its rectangle,
  ;; (row col rows cols), or #f to be nowhere this frame; area is what it
  ;; may go over (an area: the screen's size, the rows the panes have, the
  ;; focused pane's cursor). (key spec text) says whether it took a key,
  ;; text what the key types (#f if nothing); or key is #f: it takes none. The editor's own overlays -- prompts, popups,
  ;; the key legend -- follow from a client's state (display.sls makes
  ;; them); an extension shows its own with show-overlay!, the last shown
  ;; on top, and a prompt over them all.

  (define-record-type overlay (fields name place widget key))

  ;; rows, cols: the screen's. top, bottom: the first row the panes have
  ;; and the one after their last. cursor: where the focused pane's cursor
  ;; is, (row col), or #f.
  (define-record-type area (fields rows cols top bottom cursor))

  ;; The current client's overlays, from the bottom up.
  (define (client-overlays c) (client-local c 'overlays '()))

  (define (show-overlay! o)
    (let ([c (current-client)])
      (client-local-set! c 'overlays (append (remq o (client-overlays c)) (list o)))))

  (define (hide-overlay! o)
    (let ([c (current-client)])
      (client-local-set! c 'overlays (remq o (client-overlays c)))))

  ;; The overlay on top that takes keys, or #f.
  (define (key-overlay c)
    (find overlay-key (reverse (client-overlays c))))

  ;; ---------------------------------------------------------------------------
  ;; Popups
  ;;
  ;; A popup is a floating window of text a client shows over its view, at
  ;; the right, until it is hidden (escape hides it): an agent's progress, a
  ;; command's output. It does not take the keys. (lines) gives its
  ;; contents each time it is drawn, as (text . face) pairs, a face name for
  ;; each line of text; long lines wrap, and the last lines show. footer is a
  ;; hint for its bottom border, or #f. The title and footer may be
  ;; procedures too, called each time it is drawn.

  (define-record-type popup (fields title lines footer))

  (define (current-popup) (and (current-client) (client-popup (current-client))))
  (define (show-popup! p) (client-popup-set! (current-client) p))
  (define (hide-popup!) (when (current-client) (client-popup-set! (current-client) #f)))

  ;; ---------------------------------------------------------------------------
  ;; Layers, legends and jumps, per client

  ;; The active layer: #(keymap trigger-key held? used? entered-at)
  (define (active-layer) (and (current-client) (client-layer (current-client))))
  (define (active-layer-keymap) (let ([l (active-layer)]) (and l (vector-ref l 0))))
  (define (exit-layer!) (client-layer-set! (current-client) #f))

  ;; A momentary layer is held only when the client reports key releases.
  (define (enter-layer! km key)
    (client-layer-set! (current-client)
                       (vector km key (and (keymap-momentary? km) (client-has? (current-client) "release-events"))
                               #f (real-time))))

  ;; A momentary layer shows its legend once its key has been held a moment;
  ;; a menu shows it at once.
  (define (layer-legend-visible?)
    (let ([l (active-layer)])
      (and l
           (or (not (keymap-momentary? (vector-ref l 0)))
               (>= (- (real-time) (vector-ref l 4)) (get-var 'legend-delay))))))

  ;; The milliseconds until client c's screen changes on its own, -1 for
  ;; never: the server's poll timeout.
  (define (idle-timeout c)
    (let ([l (client-layer c)])
      (if (and l (keymap-momentary? (vector-ref l 0))
               (< (- (real-time) (vector-ref l 4)) (get-var 'legend-delay)))
          (max 1 (- (get-var 'legend-delay) (- (real-time) (vector-ref l 4))))
          -1)))

  ;; Jump labels: a list of (label-string . range), and what to do with the
  ;; range picked.
  (define (jump-labels) (if (current-client) (client-jumps (current-client)) '()))
  (define (jump-callback) (client-jump-callback (current-client)))
  (define (jump-labels-set! labels k)
    (client-jumps-set! (current-client) labels)
    (client-jump-callback-set! (current-client) k))

  ;; ---------------------------------------------------------------------------
  ;; Geometry: where the client's view is drawn, which the display records
  ;; each frame: (row col height width top left).

  (define (view-geometry) (and (current-client) (client-geometry (current-client))))
  (define (view-geometry-set! g) (client-geometry-set! (current-client) g))

  ;; The cluster of text t at i (see grapheme-end in (quad util)), up to
  ;; `end`, and the columns it takes at column col: its end and columns.
  (define (cluster t i end col)
    (if (char=? (text-ref t i) #\tab)
        (values (+ i 1) (let ([tw (get-var 'tab-width)]) (- tw (modulo col tw))))
        (let* ([ref (lambda (k) (text-ref t k))] [j (grapheme-end ref i end)])
          (values j (grapheme-columns ref i j)))))

  ;; The position after the grapheme cluster at p, and the start of the
  ;; one before p: where moving and deleting by characters goes.
  (define (grapheme-after b p)
    (let ([t (buffer-text b)])
      (grapheme-end (lambda (i) (text-ref t i)) p (text-length t))))

  (define (grapheme-before b p)
    (if (<= p 0)
        0
        (let ([t (buffer-text b)])
          (grapheme-start (lambda (i) (text-ref t i)) (- p 1)))))

  ;; The display column of pos on its line.
  (define (display-column b pos)
    (let* ([t (buffer-text b)] [s (text-line-start t (text-line-of t pos))])
      (let loop ([i s] [col 0])
        (if (>= i pos)
            col
            (let-values ([(j w) (cluster t i pos col)]) (loop j (+ col w)))))))

  ;; The buffer position under screen cell (row, col), or #f outside the
  ;; text area; columns left of the text (the gutter) map to the line start.
  (define (screen->position row col)
    (let ([g (view-geometry)] [b (current-buffer)])
      (and g b
           (let ([r (- row (list-ref g 0))] [c (- col (list-ref g 1))])
             (and (<= 0 r (- (list-ref g 2) 1))
                  (let* ([t (buffer-text b)]
                         [line (+ r (list-ref g 4))])
                    (if (>= line (text-line-count t))
                        (buffer-length b)
                        (let ([goal (+ (max 0 c) (list-ref g 5))]
                              [s (text-line-start t line)] [e (text-line-end t line)])
                          (let loop ([i s] [col 0])
                            (if (>= i e)
                                e
                                (let-values ([(j w) (cluster t i e col)])
                                  (if (> (+ col w) goal) i (loop j (+ col w)))))))))))))))
