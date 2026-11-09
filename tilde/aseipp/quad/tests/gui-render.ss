;; gui-render.ss -- what the window draws, drawn with no window
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Frames of a real editor, drawn as the window draws them (core/gui.sls,
;; kernel/render/) into images, and checked against the cells a terminal
;; shows: backgrounds exactly, text where there is text, box drawing
;; joining up. It runs on whatever Vulkan device QUAD_GUI_DEVICE names
;; (BUILD's :test-gui-render asks for Mesa's lavapipe, a software renderer,
;; so that results do not depend on a GPU), with the system's fonts; with
;; no Vulkan, it says SKIP and passes.

(define h (headless-gpu (get-var 'gui-font-family) 12 #t))
(printf "drawing with ~a\n" (caddr (gui-headless-info h)))

(define rows 14)
(define cols 50)
(headless-start! rows cols)
(define buf (headless-buffer! "(define (hello world) 42)\n\n█ ▀ ▄\n" 'scheme))

;; A client keeping a grid model, as the window does.
(define-values (gui model) (model-client! "gui" rows cols '()))
(with-client gui (lambda () (switch-to-buffer! buf)))
(redraw!)

(define default-bg (or (face-bg (face-ref 'ui.background)) #x282c34))
(define default-fg (or (face-fg (face-ref 'ui.text)) #xffffff))

(define-values (cell-w cell-h)
  (let ([info (gui-headless-info h)])
    (values (string->number (car info)) (string->number (cadr info)))))

(define image #f)
(define width #f)
(define (draw!)
  (let-values ([(w ht px) (draw-frame-image h model)])
    (set! width w)
    (set! image px)))

(define (pixel x y)
  (let ([o (* 4 (+ (* y width) x))])
    (logior (ash (bytevector-u8-ref image o) 16)
            (ash (bytevector-u8-ref image (+ o 1)) 8)
            (bytevector-u8-ref image (+ o 2)))))

;; What a cell shows behind its text, and its text's color.
(define (cell-colors row col)
  (let ([h (grid-model-hl model (cdr (grid-model-cell model row col)))])
    (if h
        (let ([f (car h)] [b (cadr h)] [flags (caddr h)])
          (if (logtest flags 32)
              (values (or b default-bg) (or f default-fg))
              (values (or f default-fg) (or b default-bg))))
        (values default-fg default-bg))))
(define (cell-fg row col) (let-values ([(f b) (cell-colors row col)]) f))
(define (cell-bg row col) (let-values ([(f b) (cell-colors row col)]) b))
(define (cell-text row col) (car (grid-model-cell model row col)))

;; The pixels of a cell, row by row.
(define (cell-pixels row col)
  (map (lambda (y)
         (map (lambda (x) (pixel (+ (* col cell-w) x) (+ (* row cell-h) y))) (iota cell-w)))
       (iota cell-h)))

(define (cells-where pred)
  (let loop ([row 0] [col 0] [acc '()])
    (cond
     [(= row rows) (reverse acc)]
     [(= col cols) (loop (+ row 1) 0 acc)]
     [(pred row col) (loop row (+ col 1) (cons (cons row col) acc))]
     [else (loop row (+ col 1) acc)])))

(define cursor-cell?
  (lambda (row col)
    (let ([c (grid-model-cursor model)]) (and c (= (car c) row) (= (cadr c) col)))))

(define (check-frame what)
  (draw!)
  (check (string-append what ": blank cells show exactly their background")
         (for-all (lambda (rc)
                    (let ([row (car rc)] [col (cdr rc)])
                      (or (= (pixel (+ (* col cell-w) (quotient cell-w 2)) (+ (* row cell-h) (quotient cell-h 2)))
                             (cell-bg row col))
                          (begin (printf "  cell ~a,~a: ~x, not ~x\n" row col
                                         (pixel (+ (* col cell-w) (quotient cell-w 2)) (+ (* row cell-h) (quotient cell-h 2)))
                                         (cell-bg row col))
                                 #f))))
                  (cells-where (lambda (r c) (and (string=? (cell-text r c) " ") (not (cursor-cell? r c)))))))
  (check (string-append what ": letters and digits have ink")
         (for-all (lambda (rc)
                    (let ([bg (cell-bg (car rc) (cdr rc))])
                      (exists (lambda (line) (exists (lambda (p) (not (= p bg))) line))
                              (cell-pixels (car rc) (cdr rc)))))
                  (cells-where (lambda (r c)
                                 (let ([t (cell-text r c)])
                                   (and (= (string-length t) 1)
                                        (char-alphabetic? (string-ref t 0))
                                        (not (cursor-cell? r c)))))))))

(check-frame "the buffer")

;; Blocks fill their cells exactly: █ whole in its text's color, ▀ and ▄
;; their halves.
(let ([full (cells-where (lambda (r c) (string=? (cell-text r c) "█")))])
  (check "a full block is found" (pair? full))
  (for-each
   (lambda (rc)
     (let ([fg (cell-fg (car rc) (cdr rc))])
       (check "a full block fills its cell in its color"
              (for-all (lambda (line) (for-all (lambda (p) (= p fg)) line))
                       (cell-pixels (car rc) (cdr rc))))))
   full))
(let ([upper (cells-where (lambda (r c) (string=? (cell-text r c) "▀")))])
  (for-each
   (lambda (rc)
     (let ([fg (cell-fg (car rc) (cdr rc))] [bg (cell-bg (car rc) (cdr rc))] [lines (cell-pixels (car rc) (cdr rc))])
       (check "an upper half block is its top half"
              (and (for-all (lambda (p) (= p fg)) (car lines))
                   (for-all (lambda (p) (= p bg)) (list-ref lines (- cell-h 1)))))))
   upper))

;; A picker, framed in box drawing (╭─╮ │ ╰─╯): the lines reach their
;; cells' edges, so the frame joins up.
(with-client gui (lambda () (pick "Pick one" '(("alpha" . 1) ("beta" . 2)) void)))
(redraw!)
(check-frame "a picker")
(define (spans? lines bg)
  ;; Some row (or, given columns, column) of pixels is ink from edge to edge.
  (exists (lambda (line) (for-all (lambda (p) (not (= p bg))) line)) lines))
(define (columns lines) (apply map list lines))
(let ([horizontal (cells-where (lambda (r c) (string=? (cell-text r c) "─")))]
      [vertical (cells-where (lambda (r c) (string=? (cell-text r c) "│")))])
  (check "the picker is framed" (and (pair? horizontal) (pair? vertical)))
  (check "─ reaches its cell's sides"
         (for-all (lambda (rc) (spans? (cell-pixels (car rc) (cdr rc)) (cell-bg (car rc) (cdr rc)))) horizontal))
  (check "│ reaches its cell's top and bottom"
         (for-all (lambda (rc) (spans? (columns (cell-pixels (car rc) (cdr rc))) (cell-bg (car rc) (cdr rc)))) vertical)))

;; Underlines: keywords underlined by the theme have a line from edge to
;; edge under their text.
(with-client gui close-prompt!)
(set-face! 'keyword.special '((fg lilac) bold underline))
(redraw!)
(draw!)
(let ([underlined (cells-where (lambda (r c)
                                 (let ([h (grid-model-hl model (cdr (grid-model-cell model r c)))])
                                   (and h (logtest (caddr h) 4)))))])
  (check "keywords are underlined" (pair? underlined))
  (check "underlines reach their cells' sides"
         (for-all (lambda (rc)
                    (let ([lines (cell-pixels (car rc) (cdr rc))] [fg (cell-fg (car rc) (cdr rc))])
                      ;; Below the middle: under the text.
                      (exists (lambda (line) (for-all (lambda (p) (= p fg)) line))
                              (list-tail lines (quotient cell-h 2)))))
                  underlined)))

;; The other lines: each in the place a terminal draws it.
(define (ink? p rc) (not (= p (cell-bg (car rc) (cdr rc)))))
(define (rows-of rc from to) (list-head (list-tail (cell-pixels (car rc) (cdr rc)) from) (- to from)))
(define (lined name spec pred)
  (set-face! 'keyword.special `((fg lilac) ,spec))
  (redraw!)
  (draw!)
  (let ([cells (cells-where (lambda (r c)
                              (let ([h (grid-model-hl model (cdr (grid-model-cell model r c)))])
                                (and h (not (zero? (logand (caddr h) (logior 64 128 256 512 1024))))))))])
    (check (string-append name ": drawn") (pair? cells))
    (check (string-append name ": where it belongs") (for-all pred cells))))
(define (full? rc line) (for-all (lambda (p) (ink? p rc)) line))
(lined "strikethrough" 'strikethrough
       (lambda (rc) (exists (lambda (l) (full? rc l)) (rows-of rc (quotient cell-h 4) (quotient (* 3 cell-h) 4)))))
(lined "overline" 'overline (lambda (rc) (full? rc (car (cell-pixels (car rc) (cdr rc))))))
(lined "double underline" 'double-underline
       (lambda (rc) (>= (length (filter (lambda (l) (full? rc l)) (rows-of rc (quotient cell-h 2) cell-h))) 2)))
(lined "dotted underline" 'dotted-underline
       (lambda (rc)
         ;; Some row below the text goes ink, not, ink, not...
         (exists (lambda (l)
                   (let loop ([ps (cdr l)] [last (ink? (car l) rc)] [changes 0])
                     (if (null? ps)
                         (>= changes 4)
                         (let ([i (ink? (car ps) rc)])
                           (loop (cdr ps) i (if (eq? i last) changes (+ changes 1)))))))
                 (rows-of rc (quotient (* 3 cell-h) 4) cell-h))))
(lined "dashed underline" 'dashed-underline
       (lambda (rc)
         ;; A row below the text inked in the middle, not at the edges.
         (exists (lambda (l)
                   (and (ink? (list-ref l (quotient cell-w 2)) rc)
                        (not (ink? (car l) rc)) (not (ink? (list-ref l (- cell-w 1)) rc))))
                 (rows-of rc (quotient (* 3 cell-h) 4) cell-h))))

;; ---------------------------------------------------------------------------
;; Images: a PNG, red on its left half and blue on its right, is drawn at
;; its own size, centered across the text area and at its top, and the
;; cells around it are the background.

(define png
  (let ([px (make-bytevector (* 40 20 4) 0)])
    (do ([i 0 (+ i 1)]) ((= i (* 40 20)))
      (let ([left? (< (modulo i 40) 20)])
        (bytevector-u8-set! px (* 4 i) (if left? 255 0))
        (bytevector-u8-set! px (+ (* 4 i) 2) (if left? 0 255))
        (bytevector-u8-set! px (+ (* 4 i) 3) 255)))
    (png-encode 40 20 px)))
(define png-dir (test-temp-dir "render"))
(define png-path (string-append png-dir "/two.png"))
(call-with-port (open-file-output-port png-path) (lambda (p) (put-bytevector p png)))

(define-values (viewer viewing) (model-client! "gui" rows cols '("images")))
(with-client viewer (lambda () (switch-to-buffer! (open-file! png-path))))
(redraw!)
(define placed (car (grid-model-images viewing)))
(gui-headless-image! h (car placed) png)
(let-values ([(w ht px) (draw-frame-image h viewing)])
  (set! width w)
  (set! image px))
(let* ([top (* (list-ref placed 1) cell-h)]
       [x0 (+ (* (list-ref placed 2) cell-w) (quotient (- (* (list-ref placed 4) cell-w) 40) 2))])
  (expect-equal "an image's left half" (pixel (+ x0 5) (+ top 10)) #xff0000)
  (expect-equal "and its right half" (pixel (+ x0 35) (+ top 10)) #x0000ff)
  (expect-equal "the background beside it" (pixel (- x0 2) (+ top 10)) default-bg)
  (expect-equal "and below it" (pixel (+ x0 5) (+ top 22)) default-bg))

;; ---------------------------------------------------------------------------
;; Emoji, from a color font where there is one: in their own colors (the
;; smiling face is yellow), which neither the text's color nor the
;; background, nor any blend of the two, is.

(define-values (emoji-client emoji-view) (model-client! "gui" rows cols '()))
(with-client emoji-client (lambda () (switch-to-buffer! (headless-buffer! "😀 🦀\n" 'fundamental))))
(redraw!)
(let-values ([(w ht px) (draw-frame-image h emoji-view)])
  (set! width w)
  (set! image px))
(define (yellow? p)
  (let ([r (ash p -16)] [g (logand (ash p -8) 255)] [b (logand p 255)])
    (and (> r 200) (> g 150) (< b 100))))
(let ([at (let loop ([row 0] [col 0])
            (cond
             [(= row rows) #f]
             [(= col cols) (loop (+ row 1) 0)]
             [(equal? (car (grid-model-cell emoji-view row col)) "😀") (cons row col)]
             [else (loop row (+ col 1))]))])
  (check "the emoji is on the screen" at)
  (if (not (= 0 (system "fc-list :color=true family 2>/dev/null | grep -q .")))
      (printf "no color emoji font here: emoji not checked\n")
      (check "an emoji is drawn in its colors, two cells wide"
             (let ([yellow (map (lambda (dx)
                                  (exists (lambda (y)
                                            (exists (lambda (x) (yellow? (pixel (+ (* (+ (cdr at) dx) cell-w) x)
                                                                                (+ (* (car at) cell-h) y))))
                                                    (iota cell-w)))
                                          (iota cell-h)))
                                '(0 1))])
               (and (car yellow) (cadr yellow))))))

;; ---------------------------------------------------------------------------
;; Frames drawn a changed row at a time, onto what the window kept, are
;; what drawing each whole gives, pixel for pixel, through an editing
;; session: typing, moving, scrolling (rows moved by scroll hints), a
;; picker over the text and gone again, another buffer.

(define inc (gui-headless (get-var 'gui-font-family) 12 #t))
(define inc-model (make-grid-model))
(define inc-painter (make-painter))
(define long (headless-buffer! (apply string-append
                                      (map (lambda (i) (format "(define (line-~a x) (+ x ~a)) ; ~a\n" i i (make-string (modulo i 7) #\*)))
                                           (iota 120)))
                               'scheme))
(define editor (server-connect! "gui" rows cols '("scroll")
                                (lambda (m) (grid-model-apply! inc-model m) (painter-note! inc-painter inc-model m))
                                void))
(with-client editor (lambda () (switch-to-buffer! long)))
(redraw!)

(define (first-difference a b)
  (let loop ([i 0])
    (cond [(= i (bytevector-length a)) #f]
          [(= (bytevector-u8-ref a i) (bytevector-u8-ref b i)) (loop (+ i 1))]
          [else (let ([p (quotient i 4)]) (list 'x (modulo p width) 'y (quotient p width)))])))

(for-each
 (lambda (step)
   (with-client editor (cdr step))
   (redraw!)
   (let-values ([(w1 h1 incremental) (draw-frame-image inc inc-model inc-painter)]
                [(w2 h2 whole) (draw-frame-image h inc-model)])
     (set! width w1)
     (expect-equal (string-append "drawn a row at a time, as whole: " (car step))
                   (first-difference incremental whole) #f)))
 (list (cons "the first frame" void)
       (cons "a line down" (lambda () (run-command 'move-down)))
       (cons "typing" (lambda () (run-command (lambda () (buffer-edit! long (list (list 40 40 "hello, ")))))))
       (cons "half a page down" (lambda () (run-command 'scroll-down)))
       (cons "the wheel, up" (lambda () (client-receive! (current-client) '("mouse" "scroll-up" 0 5 5 0))))
       (cons "far down" (lambda () (run-command (lambda () (goto-line! 100)))))
       (cons "a picker" (lambda () (run-command 'command-palette)))
       (cons "and gone" (lambda () (run-command 'prompt-cancel)))
       (cons "another buffer" (lambda () (switch-to-buffer! buf)))
       (cons "and back" (lambda () (switch-to-buffer! long)))))
