;; canvas.sls -- what frames are drawn on: grids of cells, and drawing on them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A grid is rows of cells, each a character (or a grapheme cluster, as a
;; string) and a face: a client's frame (display.sls), or a canvas for a
;; pane's component or a widget to draw on (widget.sls). Faces are merged
;; and interned here, so that cells compare with eq?.
(library (quad canvas)
  (export face-merge F UI ui-face
          make-grid grid? grid-rows grid-cols grid-chars grid-faces grid-images grid-images-set!
          new-grid put! face-at put-string! fill-row! blit! draw-box! wrap-text wrap-starts pretty-key)
  (import (chezscheme) (quad util) (quad face))

  ;; ---------------------------------------------------------------------------
  ;; Faces, interned so cells compare with eq?

  (define merged (make-eq-hashtable))
  (define (face-merge base top)
    (if (eq? top default-face)
        base
        (let ([inner (or (hashtable-ref merged base #f)
                         (let ([h (make-eq-hashtable)]) (hashtable-set! merged base h) h))])
          (or (hashtable-ref inner top #f)
              (let ([f (merge-faces base top)]) (hashtable-set! inner top f) f)))))

  (define (F name) (face-ref name))
  (define (UI name) (face-merge (F 'ui) (F name)))
  (define (ui-face name) (UI name))

  ;; ---------------------------------------------------------------------------
  ;; Grids

  ;; images: (picture row col rows cols) for each picture placed.
  (define-record-type grid (fields rows cols chars faces (mutable images)))

  (define (new-grid rows cols face)
    (make-grid rows cols
               (let ([v (make-vector rows)])
                 (do ([r 0 (+ r 1)]) ((= r rows) v) (vector-set! v r (make-vector cols #\space))))
               (let ([v (make-vector rows)])
                 (do ([r 0 (+ r 1)]) ((= r rows) v) (vector-set! v r (make-vector cols face))))
               '()))

  (define (put! g r c ch face)
    (when (and (< -1 r (grid-rows g)) (< -1 c (grid-cols g)))
      (vector-set! (vector-ref (grid-chars g) r) c ch)
      (vector-set! (vector-ref (grid-faces g) r) c face)))

  (define (face-at g r c) (vector-ref (vector-ref (grid-faces g) r) c))

  ;; Write a string at (r, c), clipped to `limit` columns; returns the
  ;; column after it.
  (define put-string!
    (case-lambda
     [(g r c s face) (put-string! g r c s face (grid-cols g))]
     [(g r c s face limit)
      (let ([ref (lambda (i) (string-ref s i))] [n (string-length s)])
        (let loop ([i 0] [col c])
          (if (or (= i n) (>= col limit))
              col
              (let* ([j (grapheme-end ref i n)] [w (grapheme-columns ref i j)])
                (cond
                 [(= w 0) (loop j col)]
                 [(> (+ col w) limit) col]
                 [else
                  (put! g r col (if (= j (+ i 1)) (string-ref s i) (substring s i j)) face)
                  (when (= w 2) (put! g r (+ col 1) 'wide face))
                  (loop j (+ col w))])))))]))

  (define (fill-row! g r c0 c1 face)
    (do ([c c0 (+ c 1)]) ((>= c c1)) (put! g r c #\space face)))

  ;; ---------------------------------------------------------------------------
  ;; Drawing

  ;; Draw client c's frame and send it what changed. The client's own
  ;; state (prompt, layer, message, view) is current while drawing.
  ;; Copy grid sub into g, its top left at (row, col).
  (define (blit! g sub row col)
    (do ([i 0 (+ i 1)]) ((or (= i (grid-rows sub)) (>= (+ row i) (grid-rows g))))
      (let ([sc (vector-ref (grid-chars sub) i)] [sf (vector-ref (grid-faces sub) i)]
            [dc (vector-ref (grid-chars g) (+ row i))] [df (vector-ref (grid-faces g) (+ row i))])
        (do ([j 0 (+ j 1)]) ((or (= j (grid-cols sub)) (>= (+ col j) (grid-cols g))))
          (vector-set! dc (+ col j) (vector-ref sc j))
          (vector-set! df (+ col j) (vector-ref sf j)))))
    (grid-images-set! g (append (map (lambda (im) (list (car im) (+ row (cadr im)) (+ col (caddr im))
                                                       (cadddr im) (list-ref im 4)))
                                     (grid-images sub))
                                (grid-images g))))

  (define (draw-box! g top left height width title)
    (let ([border (UI 'ui.popup.border)] [bg (UI 'ui.popup)])
      (do ([r 0 (+ r 1)]) ((= r height))
        (fill-row! g (+ top r) left (+ left width) bg))
      (put! g top left #\╭ border)
      (put! g top (+ left width -1) #\╮ border)
      (put! g (+ top height -1) left #\╰ border)
      (put! g (+ top height -1) (+ left width -1) #\╯ border)
      (do ([c 1 (+ c 1)]) ((>= c (- width 1)))
        (put! g top (+ left c) #\─ border)
        (put! g (+ top height -1) (+ left c) #\─ border))
      (do ([r 1 (+ r 1)]) ((>= r (- height 1)))
        (put! g (+ top r) left #\│ border)
        (put! g (+ top r) (+ left width -1) #\│ border))
      (when title
        (put-string! g top (+ left 2) (string-append " " title " ") (UI 'ui.popup.title) (+ left width -2)))))

  ;; Split text into lines of at most width columns, at spaces where it can.
  (define (wrap-text text width)
    (apply append
           (map (lambda (line)
                  (let loop ([line line] [acc '()])
                    (if (<= (string-width line) width)
                        (reverse (cons line acc))
                        (let* ([ref (lambda (i) (string-ref line i))]
                               [n (string-length line)]
                               [cut (let fit ([i 0] [w 0])
                                      (if (= i n)
                                          i
                                          (let* ([j (grapheme-end ref i n)] [cw (grapheme-columns ref i j)])
                                            (if (> (+ w cw) width) i (fit j (+ w cw))))))]
                               [space (let back ([i cut])
                                        (cond [(<= i 0) #f]
                                              [(char=? (string-ref line i) #\space) i]
                                              [else (back (- i 1))]))]
                               [at (if (and space (> space 0)) space (max 1 cut))])
                          (loop (string-trim-left (substring line at (string-length line)))
                                (cons (substring line 0 at) acc))))))
                (string-split text #\newline))))

  ;; Where lines of at most width columns start in s, breaking after a space
  ;; where it can and after a newline always; no character is dropped, so a
  ;; cursor index falls in exactly one line.
  (define (wrap-starts s width)
    (let ([n (string-length s)] [ref (lambda (i) (string-ref s i))])
      (let loop ([start 0] [acc '()])
        (let fit ([i start] [w 0] [space #f])
          (if (= i n)
              (reverse (cons start acc))
              (let* ([j (grapheme-end ref i n)] [cw (grapheme-columns ref i j)])
                (cond
                 [(char=? (string-ref s i) #\newline) (loop (+ i 1) (cons start acc))]
                 [(and (> i start) (> (+ w cw) width))
                  (loop (or space i) (cons start acc))]
                 [else (fit j (+ w cw)
                            (if (char=? (string-ref s i) #\space) (+ i 1) space))])))))))

  (define (pretty-key k)
    (cond [(string=? k "space") "␣"]
          [(string=? k "enter") "⏎"]
          [(string=? k "backspace") "⌫"]
          [(string=? k "tab") "⇥"]
          [(string=? k "esc") "⎋"]
          [else k])))
