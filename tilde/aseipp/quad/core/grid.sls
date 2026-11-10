;; grid.sls -- a client's copy of the screen, built from server messages
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; What a client keeps to know what is on its screen: the cells, the
;; highlights they use, the cursor and the images placed over the cells,
;; from the "grid", "line", "hl", "scroll", "cursor" and "images" messages. The tests read the screen through this; a graphical
;; client keeps the same model and draws it.
(library (quad grid)
  (export make-grid-model grid-model? grid-model-rows grid-model-cols
          grid-model-apply! grid-model-lines grid-model-row grid-model-cursor
          grid-model-cell grid-model-hl grid-model-frames grid-model-other grid-model-images
          grid-model-effects grid-model-effects-received)
  (import (chezscheme) (quad util))

  (define-record-type grid-model
    (fields (mutable rows) (mutable cols) (mutable cells) hls
            (mutable cursor) (mutable frames) (mutable other) (mutable images)
            ;; The effects placed, as "effects" has them, and when (real
            ;; time) they came, from which their ages count.
            (mutable effects) (mutable effects-received))
    (protocol (lambda (new) (lambda () (new 0 0 (vector) (make-eqv-hashtable) #f 0 '() '() '() 0)))))

  ;; Apply a message. Messages that are not about the screen are kept,
  ;; newest first, in grid-model-other.
  (define (grid-model-apply! g msg)
    (case (string->symbol (car msg))
      [(grid)
       (let ([rows (cadr msg)] [cols (caddr msg)])
         (grid-model-rows-set! g rows)
         (grid-model-cols-set! g cols)
         (grid-model-cells-set! g (let ([v (make-vector rows)])
                                    (do ([r 0 (+ r 1)]) ((= r rows) v)
                                      (vector-set! v r (make-vector cols (cons " " 0)))))))]
      [(line)
       (let ([row (vector-ref (grid-model-cells g) (cadr msg))])
         ;; Cells are (text [hl [repeat]]); hl carries over from the last.
         (let loop ([cells (cadddr msg)] [col (caddr msg)] [hl 0])
           (unless (null? cells)
             (let* ([cell (car cells)]
                    [text (car cell)]
                    [hl (if (pair? (cdr cell)) (cadr cell) hl)]
                    [n (if (and (pair? (cdr cell)) (pair? (cddr cell))) (caddr cell) 1)])
               ;; A run's cells are one cell: none is changed in place.
               (let ([c (cons text hl)])
                 (do ([i col (+ i 1)]) ((>= i (min (+ col n) (vector-length row))))
                   (vector-set! row i c)))
               (loop (cdr cells) (+ col n) hl)))))]
      [(hl) (hashtable-set! (grid-model-hls g) (cadr msg) (cddr msg))]
      ;; Rows top to bottom move up by n (down for n < 0); those scrolled
      ;; in are blank until lines fill them.
      [(scroll)
       (let ([top (cadr msg)] [bottom (caddr msg)] [n (cadddr msg)]
             [rows (vector-copy (grid-model-cells g))])
         (do ([r top (+ r 1)]) ((= r bottom))
           (let ([from (+ r n)])
             (vector-set! (grid-model-cells g) r
                          (if (and (>= from top) (< from bottom))
                              (vector-ref rows from)
                              (make-vector (grid-model-cols g) (cons " " 0)))))))]
      [(cursor) (grid-model-cursor-set! g (and (cadr msg) (cdr msg)))]
      ;; (key row col rows cols shown) for each image placed.
      [(images) (grid-model-images-set! g (cadr msg))]
      [(effects) (grid-model-effects-set! g (cadr msg)) (grid-model-effects-received-set! g (real-time))]
      [(flush) (grid-model-frames-set! g (+ 1 (grid-model-frames g)))]
      [else (grid-model-other-set! g (cons msg (grid-model-other g)))]))

  (define (grid-model-cell g row col) (vector-ref (vector-ref (grid-model-cells g) row) col))

  ;; A row as text: wide characters' right halves are empty strings.
  (define (grid-model-row g r)
    (apply string-append (map car (vector->list (vector-ref (grid-model-cells g) r)))))

  (define (grid-model-lines g)
    (map (lambda (r) (grid-model-row g r)) (iota (grid-model-rows g))))

  ;; A highlight's (fg bg flags underline-color link).
  (define (grid-model-hl g id) (hashtable-ref (grid-model-hls g) id #f)))
