;; color.sls -- colors: 24-bit, or the terminal's own palette
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A color is an integer: #xRRGGBB, or one of the terminal's palette of
;; 256 (indexed-color n), which a terminal draws as it is set up to -- 0 to
;; 7 its black, red, green, yellow, blue, magenta, cyan and white, 8 to 15
;; their bright kinds -- so that a theme can take the terminal's colors.
;; Both go to clients as they are; a terminal client turns 24-bit colors
;; into the nearest of the palette when it has no more (term.sls), judged
;; by xterm's palette, the likeliest; and a window, which is its own
;; terminal, draws the first 16 as Tomorrow Night has them (xterm's are
;; too harsh to read on a dark background), and the rest as xterm's.
(library (quad color)
  (export indexed-color indexed-color? indexed-color-index color-rgb
          nearest-256 nearest-16 blend-colors color-red color-green color-blue)
  (import (chezscheme))

  (define indexed-base #x1000000)

  (define (indexed-color n)
    (unless (and (fixnum? n) (<= 0 n 255)) (errorf 'indexed-color "not a palette index: ~s" n))
    (+ indexed-base n))
  (define (indexed-color? c) (and (integer? c) (<= indexed-base c (+ indexed-base 255))))
  (define (indexed-color-index c) (- c indexed-base))

  (define (color-red c) (ash c -16))
  (define (color-green c) (logand (ash c -8) 255))
  (define (color-blue c) (logand c 255))
  (define (rgb r g b) (logior (ash r 16) (ash g 8) b))

  ;; xterm's palette: its 16, the 6x6x6 cube, then the grays.
  (define the-16
    '#(#x000000 #xcd0000 #x00cd00 #xcdcd00 #x0000ee #xcd00cd #x00cdcd #xe5e5e5
       #x7f7f7f #xff0000 #x00ff00 #xffff00 #x5c5cff #xff00ff #x00ffff #xffffff))
  (define cube-levels '#(0 95 135 175 215 255))

  (define (palette-rgb n)
    (cond
     [(< n 16) (vector-ref the-16 n)]
     [(< n 232)
      (let ([i (- n 16)])
        (rgb (vector-ref cube-levels (quotient i 36))
             (vector-ref cube-levels (modulo (quotient i 6) 6))
             (vector-ref cube-levels (modulo i 6))))]
     [else (let ([v (+ 8 (* 10 (- n 232)))]) (rgb v v v))]))

  (define window-16
    '#(#x1d1f21 #xcc6666 #xb5bd68 #xf0c674 #x81a2be #xb294bb #x8abeb7 #xc5c8c6
       #x666666 #xd54e53 #xb9ca4a #xe7c547 #x7aa6da #xc397d8 #x70c0b1 #xeaeaea))

  ;; A color as #xRRGGBB, as a window draws it.
  (define (color-rgb c)
    (if (indexed-color? c)
        (let ([n (indexed-color-index c)]) (if (< n 16) (vector-ref window-16 n) (palette-rgb n)))
        c))

  ;; How far apart two colors look: squared distance, weighted for the
  ;; eye (red and blue by how red the pair is: the "redmean" estimate).
  (define (distance a b)
    (let* ([r1 (color-red a)] [r2 (color-red b)]
           [rm (quotient (+ r1 r2) 2)]
           [dr (- r1 r2)] [dg (- (color-green a) (color-green b))] [db (- (color-blue a) (color-blue b))])
      (+ (quotient (* (+ 512 rm) dr dr) 256) (* 4 dg dg) (quotient (* (- 767 rm) db db) 256))))

  (define (nearest c from to)
    (let ([c (if (indexed-color? c) (palette-rgb (indexed-color-index c)) c)])
      (let loop ([n from] [best from] [d #f])
        (if (> n to)
            best
            (let ([dn (distance c (palette-rgb n))])
              (if (or (not d) (< dn d)) (loop (+ n 1) n dn) (loop (+ n 1) best d)))))))

  ;; The palette index nearest a color: of the cube and grays (which the
  ;; terminal is less likely to have changed than its first 16), or of
  ;; the 16. A palette color is itself.
  (define (nearest-256 c)
    (if (indexed-color? c) (indexed-color-index c) (nearest c 16 255)))
  (define (nearest-16 c)
    (if (and (indexed-color? c) (< (indexed-color-index c) 16)) (indexed-color-index c) (nearest c 0 15)))

  ;; a and b mixed, t of the way from a to b (0 to 1).
  (define (blend-colors a b t)
    (let ([a (color-rgb a)] [b (color-rgb b)]
          [mix (lambda (x y) (exact (round (+ x (* t (- y x))))))])
      (rgb (mix (color-red a) (color-red b)) (mix (color-green a) (color-green b))
           (mix (color-blue a) (color-blue b))))))
