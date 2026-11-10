;; anim.ss -- animation: values that move, timelines, staggers, effects,
;; and how each kind of client draws an effect
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The clock is the test's: time moves when it says.

(headless-start! 12 60)
(define now 0)
(anim-clock-set! (lambda () now))
(define (at! ms) (set! now ms) (anim-tick!))
(define (near? a b) (< (abs (- a b)) 1e-6))

;; A value, moved.
(define x (animated 0))
(define a (animate! x 100 'duration 1000 'easing 'linear))
(check "it moves" (animations-running?))
(check "and wants frames" (>= (anim-timeout) 0))
(at! 250)
(check "a quarter" (near? (animated-value x) 25))
(at! 1000)
(check "there" (and (near? (animated-value x) 100) (animation-finished? a)))
(check "nothing moves: no frames" (and (not (animations-running?)) (= (anim-timeout) -1)))

;; Easings, from the kernel.
(define e (animated 0))
(set! now 0)
(animate! e 1 'duration 1000 'easing 'in-quad)
(at! 500)
(check "in-quad, half way: a quarter" (near? (animated-value e) 0.25))
(at! 1000)

;; Colors mix.
(define col (animated-color #x000000))
(set! now 0)
(animate! col #xffffff 'duration 100 'easing 'linear)
(at! 50)
(check "half way to white" (= (animated-value col) #x808080))
(at! 100)

;; Keyframes: each stretch a share.
(define k (animated 0))
(set! now 0)
(animate! k '(0 10 0) 'duration 1000 'easing 'linear)
(at! 250)
(check "keyframes: up" (near? (animated-value k) 5))
(at! 750)
(check "and down" (near? (animated-value k) 5))
(at! 1000)
(check "and back" (near? (animated-value k) 0))

;; Staggered: one after another.
(define vs (list (animated 0) (animated 0) (animated 0)))
(set! now 0)
(animate! vs 1 'duration 100 'easing 'linear 'delay (stagger 100))
(at! 150)
(check "staggered" (for-all near? (map animated-value vs) '(1 0.5 0)))
(at! 400)

;; Back and forth, for ever: alternate.
(define b (animated 0))
(set! now 0)
(define bounce (animate! b 10 'duration 100 'easing 'linear 'loop #t 'direction 'alternate))
(at! 150)
(check "alternate: on the way back" (near? (animated-value b) 5))
(animation-pause! bounce)
(at! 1000)
(check "paused: still" (near? (animated-value b) 5))
(animation-play! bounce)
(at! 1020)
(check "played again: on from there" (near? (animated-value b) 3))
(animation-seek! bounce 50)
(check "sought" (near? (animated-value b) 5))
(animation-pause! bounce)

;; A timeline: one after another, or overlapping.
(define t1 (animated 0))
(define t2 (animated 0))
(set! now 0)
(define tl (timeline 'easing 'linear 'duration 100))
(timeline-add! tl t1 10)
(timeline-add! tl t2 20 'offset "-=50")
(at! 75)
(check "timeline: the first" (near? (animated-value t1) 7.5))
(check "the second, begun at 50" (near? (animated-value t2) 5))
(at! 200)
(check "both done" (and (near? (animated-value t1) 10) (near? (animated-value t2) 20) (animation-finished? tl)))

;; Reduced motion: at the end at once.
(set-var! 'animations #f)
(define r (animated 0))
(animate! r 9 'duration 5000)
(check "reduced motion: there at once" (near? (animated-value r) 9))
(set-var! 'animations #t)

;; ---------------------------------------------------------------------------
;; Effects: a sheen over blocks, as a window, a terminal that shows images,
;; and any other terminal draw it.

(set! now 0)
(define sheen (effect 'sheen 'width 2 'intensity 1 'duration 1000 'easing 'linear 'loop #t 'end-delay 1000))
(define blocks-face (face-merge (UI 'ui.popup) (make-face #x204060 #f)))
;; Blocks, filling a row of ten cells.
(define blocks
  (make-widget (lambda (cols) 1)
               (lambda (g row col rows cols)
                 (fill-row! g row col (+ col cols) blocks-face)
                 (put-string! g row col "██████████" blocks-face (+ col cols))
                 #f)))
(define (show-sheen!)
  (show-overlay! (make-overlay 'fx (lambda (a) '(1 1 1 10)) (with-effect blocks sheen) #f)))
(define-values (window window-model) (model-client! "window" 12 60 '("effects")))
(define-values (kitty kitty-model) (model-client! "kitty" 12 60 '("images")))
(define-values (plain plain-model) (model-client! "plain" 12 60 '()))
(for-each (lambda (c) (with-client c show-sheen!)) (list window kitty plain))
(set! now 500)
(redraw!)

;; A window is told of it once, with its age, and times it itself.
(let ([fx (grid-model-effects window-model)])
  (check "the window has it" (and (= 1 (length fx)) (= (cadr (car fx)) 1)))
  (check "where, and how old" (and (equal? (list-ref (car fx) 2) 1) (near? (list-ref (car fx) 8) 500))))
(define window-frames (grid-model-frames window-model))
(set! now 600)
(redraw!)
(check "and is sent nothing more as it moves" (= (grid-model-frames window-model) window-frames))

;; A terminal that shows images: a picture of each step, placed over the
;; cells, made once.
(define (fx-images m) (filter (lambda (i) (string-prefix? "fx:" (car i))) (grid-model-images m)))
(check "kitty: a picture over the blocks" (= 1 (length (fx-images kitty-model))))
(define first-key (car (car (fx-images kitty-model))))
(set! now 700)
(redraw!)
(check "another as it moves" (not (equal? first-key (car (car (fx-images kitty-model))))))

;; Any other terminal: the blocks' colors, shaded where the band is.
(define (fg-at m col) (car (grid-model-hl m (cdr (grid-model-cell m 1 col)))))
(set! now 500)
(redraw!)
(check "plain: lit in the middle" (> (fg-at plain-model 5) #x204060))
(check "not at the side" (= (fg-at plain-model 1) #x204060))

;; Between sweeps nothing moves: the loop waits for the next.
(set! now 1500)
(redraw!)
(check "between sweeps, the next frame is the next sweep" (= (anim-timeout) 500))
(anim-clock-set! #f)
