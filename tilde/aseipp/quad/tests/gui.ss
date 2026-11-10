;; gui.ss -- the graphical client's Scheme half, without a window
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A window needs a GPU and a display, which tests have neither of; what
;; core/gui.sls does with what the window sends, and the frames it paints,
;; are tested here.

(headless-start! 12 50)
(define buf (headless-buffer! "one two three\nfour five six\n" 'text))

;; A client keeping a grid model, as the GUI does.
(define-values (gui model) (model-client! "gui" 12 50 '("title")))
(with-client gui (lambda () (switch-to-buffer! buf)))
(redraw!)

;; ---------------------------------------------------------------------------
;; Frames: the rectangles reproduce every cell's background.

(define (rects-of bv)
  (let loop ([o 0] [acc '()])
    (if (= o (bytevector-length bv))
        (reverse acc)
        (loop (+ o 32)
              (cons (list (bytevector-ieee-single-native-ref bv o)
                          (bytevector-ieee-single-native-ref bv (+ o 4))
                          (bytevector-ieee-single-native-ref bv (+ o 8))
                          (bytevector-ieee-single-native-ref bv (+ o 12))
                          (bytevector-u32-native-ref bv (+ o 16))
                          (bytevector-u32-native-ref bv (+ o 20)))
                    acc)))))

(define default-bg (or (face-bg (face-ref 'ui.background)) #x282c34))
(define default-fg (or (face-fg (face-ref 'ui.text)) #xffffff))

;; What a terminal shows behind each cell (reverse swaps).
(define (cell-bg row col)
  (let ([h (grid-model-hl model (cdr (grid-model-cell model row col)))])
    (if h
        (let ([f (car h)] [b (cadr h)] [flags (caddr h)])
          (if (logtest flags 32) (or f default-fg) (or b default-bg)))
        default-bg)))

;; The cursor drawn last; the rest paints cells, whole ones.
(define (painted rects)
  (let ([g (make-vector (* 12 50) default-bg)])
    (for-each (lambda (r)
                (let-values ([(x y w h color edges) (apply values r)])
                  (do ([row (exact (floor y)) (+ row 1)]) ((>= row (+ y h)))
                    (do ([col (exact (floor x)) (+ col 1)]) ((>= col (+ x w)))
                      (vector-set! g (+ (* row 50) col) (logand color #xffffff))))))
              rects)
    g))

(define (row-colored? row)
  (let loop ([col 0])
    (or (= col 50) (and (not (= (cell-bg row col) default-bg)) (loop (+ col 1))))))

(let* ([cursor (grid-model-cursor model)]
       [rects (rects-of (frame-rects model))]
       [cells (if cursor (reverse (cdr (reverse rects))) rects)]
       [g (painted cells)])
  (check "rectangles are opaque" (for-all (lambda (r) (= (ash (list-ref r 4) -24) 255)) rects))
  (check "no rectangle repaints the background"
         (for-all (lambda (r) (not (= (logand (list-ref r 4) #xffffff) default-bg))) cells))
  (check "runs of cells are one rectangle each" (< (length cells) 12))
  (check "every cell's background is painted"
         (let loop ([row 0] [col 0])
           (cond
            [(= row 12) #t]
            [(= col 50) (loop (+ row 1) 0)]
            [(= (vector-ref g (+ (* row 50) col)) (cell-bg row col)) (loop row (+ col 1))]
            [else (printf "row ~a col ~a: ~x, not ~x\n" row col (vector-ref g (+ (* row 50) col)) (cell-bg row col))
                  #f])))
  ;; The window's padding takes the backgrounds along the grid's edges:
  ;; those at a row's ends reach left or right, and those of a row with
  ;; no cell in the default background may reach up or down.
  (check "backgrounds at a row's ends reach past them, and only they"
         (for-all (lambda (r)
                    (let-values ([(x y w h color edges) (apply values r)])
                      (and (eq? (logtest edges 1) (= x 0))
                           (eq? (logtest edges 2) (= (+ x w) 50)))))
                  cells))
  (check "a row's backgrounds may reach up or down when no cell is in the default one"
         (for-all (lambda (r)
                    (eq? (logtest (list-ref r 5) 16) (row-colored? (exact (list-ref r 1)))))
                  cells))
  (check "some row reaches up or down" (exists (lambda (r) (logtest (list-ref r 5) 16)) cells))
  (check "the cursor reaches nowhere" (or (not cursor) (= (list-ref (car (reverse rects)) 5) 0))))

;; The terminal cursor is drawn over its row's cells, as its shape says:
;; the last of its row's rectangles.
(define (cursor-rect)
  (car (reverse (filter (lambda (r) (= (list-ref r 1) 3.0)) (rects-of (frame-rects model))))))
(grid-model-apply! model '("cursor" 3 4 "bar"))
(let ([r (cursor-rect)])
  (expect-equal "a bar cursor" (list (list-ref r 0) (list-ref r 1) (list-ref r 3)) '(4.0 3.0 1.0))
  (check "a bar is thin" (< (list-ref r 2) 0.5)))
(grid-model-apply! model '("cursor" 3 4 "block"))
(expect-equal "a block cursor" (list-head (cursor-rect) 4) '(4.0 3.0 1.0 1.0))

;; ---------------------------------------------------------------------------
;; Text: the cells to draw, and their colors.

(define (cells-of model)
  (let-values ([(bv text) (frame-cells model)])
    (let loop ([o 0] [acc '()])
      (if (= o (bytevector-length bv))
          (reverse acc)
          (let ([u (lambda (i) (bytevector-u32-native-ref bv (+ o (* 4 i))))])
            (loop (+ o 28)
                  (cons (list (ash (u 0) -16) (logand (u 0) #xffff)       ; row, column
                              (ash (u 1) -16) (logand (u 1) #xffff)       ; width, attributes
                              (logand (u 2) #xffffff)                     ; color
                              (u 3)                                       ; behind it
                              (utf8->string (let ([b (make-bytevector (u 6))])
                                              (bytevector-copy! text (u 5) b 0 (u 6))
                                              b)))
                        acc)))))))

(define text-model (make-grid-model))
(for-each (lambda (m) (grid-model-apply! text-model m))
          `(("grid" 2 7)
            ("hl" 1 #xff0000 #f 0)
            ("hl" 2 #x00ff00 #x0000ff 32)
            ("hl" 3 #f #f 4)
            ("hl" 4 #f #f 520 #x00ff00)
            ("line" 0 0 (("a" 1) ("b") (" " 0) ("界" 1) ("") ("x" 2) (" " 3)))
            ("line" 1 3 (("s" 4)))
            ("cursor" 1 0 "block")
            ("line" 1 0 (("q" 1)))))
(expect-equal "cells with text, and underlined blanks"
              (cells-of text-model)
              `((0 0 1 0 #xff0000 ,default-bg "a")
                (0 1 1 0 #xff0000 ,default-bg "b")
                (0 3 2 0 #xff0000 ,default-bg "界")
                (0 5 1 32 #x0000ff #x00ff00 "x")
                (0 6 1 4 ,default-fg ,default-bg " ")
                ;; Under the block cursor: the background's color, on the
                ;; cursor's.
                (1 0 1 0 ,default-bg ,default-fg "q")
                ;; Undercurled in green, and struck through.
                (1 3 1 520 ,default-fg ,default-bg "s")))
(expect-equal "an underline's color goes with its cell"
              (let-values ([(bv text) (frame-cells text-model)])
                (bytevector-u32-native-ref bv (+ (* 28 6) 16)))
              #xff00ff00)

;; ---------------------------------------------------------------------------
;; Events from the window become the editor's, as a terminal's do.

(expect-equal "a character" (window-message '("char" "j" 0 "press")) '("key" "j" 0 "j" "press"))
(expect-equal "shift is in the character" (window-message '("char" "J" 1 "press")) '("key" "J" 0 "J" "press"))
(expect-equal "control types nothing" (window-message '("char" "z" 4 "press")) '("key" "z" 4 #f "press"))
(expect-equal "space" (window-message '("char" " " 0 "repeat")) '("key" "space" 0 " " "repeat"))
(expect-equal "enter" (window-message '("special" "enter" 0 "press")) '("key" "enter" 0 "\n" "press"))
(expect-equal "shift+tab" (window-message '("special" "tab" 1 "press")) '("key" "tab" 1 #f "press"))
(expect-equal "a resize" (window-message '("resize" 30 100)) '("resize" 30 100))
(expect-equal "the mouse" (window-message '("mouse" "press" 0 3 4 0)) '("mouse" "press" 0 3 4 0))
(expect-equal "the clipboard's contents" (window-message '("clipboard" "c" "copied")) '("clipboard" "c" "copied"))
(expect-equal "a dropped file is opened" (window-message '("dropped" "/tmp/x.txt")) '("open" "/tmp/x.txt" #f))
(expect-equal "not an event" (window-message '("error" "no GPU")) #f)

;; Keys from the window edit as the terminal's do.
(define (window-keys! . msgs)
  (for-each (lambda (m) (client-receive! gui (window-message m)) (redraw!)) msgs))
(window-keys! '("char" "a" 0 "press") '("char" "l" 0 "press"))
(expect-equal "the window's keys move its selection" (with-client gui primary-text) "four five six")
(window-keys! '("resize" 20 70))
(expect-equal "a resize redraws at the new size" (list (grid-model-rows model) (grid-model-cols model)) '(20 70))

;; ---------------------------------------------------------------------------
;; Fonts: the editor tells windows theirs, as zoomed and as the variables
;; change. Their size is ghostty's: 12 points, or 13 on macOS.

(expect-equal "the size is ghostty's" (get-var 'gui-font-size) (if macos? 13 12))
(set-var! 'gui-font-size 12)
(define-values (zc fonts) (model-client! "gui" 12 50 '("font")))
(define (last-font) (find (lambda (m) (equal? (car m) "font")) (grid-model-other fonts)))
(expect-equal "a window is told its font" (last-font) '("font" "JetBrains Mono" 12 "" ()))
(with-client zc (lambda () (run-command 'zoom-in)))
(expect-equal "zooming in" (last-font) '("font" "JetBrains Mono" 13 "" ()))
(with-client zc (lambda () (run-command 'zoom-out) (run-command 'zoom-out)))
(expect-equal "zooming out" (last-font) '("font" "JetBrains Mono" 11 "" ()))
(set-var! 'gui-font-size 14)
(expect-equal "a zoomed window keeps its size" (last-font) '("font" "JetBrains Mono" 11 "" ()))
(with-client zc (lambda () (run-command 'zoom-reset)))
(expect-equal "back to gui-font-size" (last-font) '("font" "JetBrains Mono" 14 "" ()))
(set-var! 'gui-font-size 12)
(expect-equal "which it follows" (last-font) '("font" "JetBrains Mono" 12 "" ()))
(set-var! 'gui-font-features "-calt ss01")
(set-var! 'gui-font-fallbacks '("Noto Sans Symbols"))
(expect-equal "and its features and fallbacks"
              (last-font) '("font" "JetBrains Mono" 12 "-calt ss01" ("Noto Sans Symbols")))
(set-var! 'gui-font-features "")
(set-var! 'gui-font-fallbacks '())
(check "a client without the capability is not told" (not (find (lambda (m) (equal? (car m) "font")) (grid-model-other model))))

;; ---------------------------------------------------------------------------
;; The pointer: its shape over what is under it, sent as it changes.

(define-values (pc pointing) (model-client! "gui" 12 50 '("pointer-shape")))
(with-client pc (lambda () (switch-to-buffer! buf)))
(redraw!)
(define (pointers) (filter (lambda (m) (equal? (car m) "pointer")) (grid-model-other pointing)))
(define frames-before (grid-model-frames pointing))
(client-receive! pc '("mouse" "move" 0 12 2 0))
(expect-equal "over text, the text cursor" (pointers) '(("pointer" "text")))
(client-receive! pc '("mouse" "move" 0 13 2 0))
(expect-equal "said once" (length (pointers)) 1)
(client-receive! pc (list "mouse" "move" 0 5 (- 12 2) 0))
(expect-equal "over the status line, the arrow" (car (pointers)) '("pointer" "default"))
(redraw!)
(expect-equal "moving draws nothing" (grid-model-frames pointing) frames-before)

;; ---------------------------------------------------------------------------
;; The text cursor: in normal mode the selection's colors show it, so it is
;; sent hidden, where it is (for screen readers), to clients that can hide
;; it; others are told there is none.

(define-values (plain plain-model) (model-client! "gui" 12 50 '()))
(define-values (hc hiding) (model-client! "gui" 12 50 '("hidden-cursor")))
(for-each (lambda (c) (with-client c (lambda () (switch-to-buffer! buf)))) (list plain hc))
(redraw!)
(expect-equal "no cursor, to clients that would draw it" (grid-model-cursor plain-model) #f)
(define at (grid-model-cursor hiding))
(check "the selection's head, hidden" (and at (equal? (caddr at) "hidden")))
(use-client! hc)
(press! "l")
(redraw!)
(check "it follows the selection" (and (grid-model-cursor hiding) (not (equal? (grid-model-cursor hiding) at))))
(press! "h")
(redraw!)
(expect-equal "in insert mode, a bar" (caddr (grid-model-cursor hiding)) "bar")
(press! "esc")
