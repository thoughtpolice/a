;; anim.sls -- animation: values that move, and effects (docs/animation.md)
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; In the manner of Anime.js. An animated value is a cell a widget reads as
;; it draws; animate! moves values to targets, each over a timing -- a
;; duration, delays before and after, iterations, a direction, an easing --
;; which the kernel computes (kernel/fx), as the window's renderer does.
;; Timelines put animations one after another, staggers spread them out,
;; and every animation can be paused, played, sought and restarted. While
;; any moves, the server's loop wakes for each frame (animation-fps) and
;; redraws; otherwise it waits, at no cost.
;;
;;   (define x (animated 0))
;;   (animate! x 30 'duration 400 'easing 'out-cubic)
;;   (animate! (list a b c) 1 'delay (stagger 80))
;;   (define tl (timeline 'easing 'out-quad))
;;   (timeline-add! tl x 10 'duration 200)
;;   (timeline-add! tl y 5 'duration 300 'offset "-=100")
;;
;; An effect is drawn over what a widget draws, finer than cells where the
;; client can (display.sls has each client draw it its own way):
;;
;;   (with-effect widget (effect 'sheen 'angle 25 'duration 1300 'loop #t))
;;
;; (set-var! 'animations #f) -- reduced motion -- makes animations jump to
;; their ends, and effects stand still.
(library (quad anim)
  (export animated animated-color animated? animated-value animated-set!
          animate! stagger timeline timeline-add!
          animation? animation-play! animation-pause! animation-restart! animation-seek!
          animation-finished? animation-elapsed
          effect effect? effect-kind effect-id effect-progress effect-next-change effect-shade
          effect-kind-number effect-params effect-color effect-timing effect-age effect-restart!
          with-effect
          timing-numbers easing-index
          anim-now anim-clock-set! anim-timeout anim-tick! anim-render-begin! anim-effect-shown!
          animations-running?)
  (import (chezscheme) (quad util) (quad color) (quad canvas) (quad widget) (quad client)
          (only (quad native) fx-easing-names fx-progress fx-next-change fx-shade))

  (define-variable animations #t "Whether things move: #f (reduced motion) jumps them to their ends.")
  (define-variable animation-fps 60 "Frames a second the editor draws while something moves.")

  ;; ---------------------------------------------------------------------------
  ;; The clock: milliseconds, as real time has them, unless a test sets it.

  (define clock real-time)
  (define (anim-now) (clock))
  (define (anim-clock-set! thunk) (set! clock (or thunk real-time)))

  (define (moving?) (get-var 'animations #f))

  ;; ---------------------------------------------------------------------------
  ;; Timings: as kernel/fx reads them, ten numbers

  (define easing-names #f)
  (define (easing-index name)
    (unless easing-names (set! easing-names (fx-easing-names)))
    (let loop ([ns easing-names] [i 0])
      (cond [(null? ns) (errorf 'animate! "no easing named ~s" name)]
            [(string=? (car ns) name) i]
            [else (loop (cdr ns) (+ i 1))])))

  ;; An easing: a name, or (cubic-bezier x1 y1 x2 y2), (steps n), (spring
  ;; mass stiffness damping velocity): its index and four arguments.
  (define (easing-numbers e)
    (cond
     [(symbol? e) (list (easing-index (symbol->string e)) 0 0 0 0)]
     [(and (pair? e) (symbol? (car e)))
      (let ([args (map inexact (cdr e))])
        (cons (easing-index (symbol->string (car e)))
              (append args (make-list (max 0 (- 4 (length args))) 0.0))))]
     [else (errorf 'animate! "not an easing: ~s" e)]))

  (define (option options key default)
    (let loop ([o options])
      (cond [(or (null? o) (null? (cdr o))) default]
            [(eq? (car o) key) (cadr o)]
            [else (loop (cddr o))])))

  ;; The ten numbers of the timing options say (delay a number here).
  (define (timing-numbers options delay)
    (let ([loop (option options 'loop #f)])
      (map inexact
           (append (list (option options 'duration 1000) delay (option options 'end-delay 0)
                         (cond [(eq? loop #t) 0] [(number? loop) (max 1 loop)] [else 1])
                         (case (option options 'direction 'normal) [(reverse) 1] [(alternate) 2] [else 0]))
                   (easing-numbers (option options 'easing 'out-quad))))))

  ;; ---------------------------------------------------------------------------
  ;; Animated values

  ;; kind: number or color (#xRRGGBB, mixed in sRGB).
  (define-record-type (animated-cell make-animated animated?) (fields (mutable value) kind))
  (define (animated v) (make-animated v 'number))
  (define (animated-color c) (make-animated c 'color))
  (define (animated-value a) (animated-cell-value a))
  (define (animated-set! a v) (animated-cell-value-set! a v))

  (define (between kind a b t)
    (if (eq? kind 'color)
        (blend-colors a b (max 0.0 (min 1.0 t)))
        (+ a (* (- b a) t))))

  ;; Where keyframes (a list of values, the first where it starts) are at
  ;; progress t: each stretch between two of them an equal share.
  (define (keyframe-value kind frames t)
    (let* ([n (- (length frames) 1)]
           [at (* (max 0.0 (min 1.0 t)) n)]
           [i (min (- n 1) (exact (floor at)))])
      (if (<= n 0)
          (car frames)
          (between kind (list-ref frames i) (list-ref frames (+ i 1)) (- at i)))))

  ;; ---------------------------------------------------------------------------
  ;; Animations
  ;;
  ;; A tween moves one value; an animation is tweens (and other
  ;; animations), each starting `offset` milliseconds after it does. start:
  ;; when it started, on the clock; paused: when it was paused, or #f.

  (define-record-type tween (fields target frames timing on-update))
  (define-record-type animation
    (fields (mutable parts) (mutable start) (mutable paused) (mutable done?) on-complete
            (mutable length)            ; its length, as far as known
            defaults))                  ; a timeline's options for what is added

  (define running '())                  ; animations playing

  (define (animation-elapsed a)
    (- (or (animation-paused a) (anim-now)) (animation-start a)))

  ;; Move each of a's tweens to where it is at its elapsed time; whether
  ;; any still moves.
  (define (advance! a)
    (let ([elapsed (animation-elapsed a)])
      (let loop ([parts (animation-parts a)] [any? #f])
        (if (null? parts)
            any?
            (let* ([p (car parts)] [offset (car p)] [t (cdr p)] [e (- elapsed offset)])
              (if (animation? t)
                  (loop (cdr parts) (or (advance-at! t e) any?))
                  (let* ([timing (tween-timing t)]
                         [progress (if (moving?) (fx-progress timing (max 0.0 (inexact e))) 1.0)]
                         [next (and (moving?) (fx-next-change timing (max 0.0 (inexact e))))])
                    ;; A tween that has not begun stays where it was.
                    (when (>= e 0)
                      (animated-set! (tween-target t)
                                     (keyframe-value (animated-cell-kind (tween-target t)) (tween-frames t) progress))
                      (when (tween-on-update t) ((tween-on-update t) (animated-value (tween-target t)))))
                    (loop (cdr parts) (or (< e 0) next any?)))))))))

  ;; A nested animation, at elapsed e of its own.
  (define (advance-at! a e)
    (let ([saved (animation-start a)])
      (animation-start-set! a (- (anim-now) e))
      (let ([r (advance! a)]) (animation-start-set! a saved) r)))

  (define (finish! a)
    (animation-done?-set! a #t)
    (set! running (remq a running))
    (when (animation-on-complete a) ((animation-on-complete a))))

  (define (play! a)
    (unless (memq a running) (set! running (cons a running)))
    (unless (moving?) (advance! a) (finish! a)))

  ;; Animate targets (an animated value, or a list of them) to `to`: a
  ;; value, or keyframes (a list, the value it starts from first). options
  ;; are the timing's -- duration (1000), delay (a number, or a procedure
  ;; of the target's index and their count, as stagger makes), end-delay,
  ;; loop (#t for ever), direction (normal, reverse, alternate), easing
  ;; (out-quad) -- and from (where it starts, else where it is), on-update
  ;; (with each new value), on-complete, autoplay (#t). Returns the
  ;; animation.
  (define (animate! targets to . options)
    (let* ([a (make-animation (tween-parts targets to options 0) (anim-now) #f #f
                              (option options 'on-complete #f) 0 '())])
      (when (option options 'autoplay #t) (play! a))
      a))

  (define (tween-parts targets to options base)
    (let* ([targets (if (list? targets) targets (list targets))]
           [n (length targets)]
           [delay (option options 'delay 0)])
      (map (lambda (t i)
             (let* ([d (if (procedure? delay) (delay i n) delay)]
                    [from (option options 'from (animated-value t))]
                    [frames (if (list? to) to (list from to))])
               (cons base (make-tween t frames (timing-numbers options d) (option options 'on-update #f)))))
           targets (iota n))))

  ;; Delays spread over targets, `step` milliseconds apart: from the first
  ;; (the default), the last, or the middle out ('from 'last, 'center);
  ;; start, more before them all.
  ;; options without those keyed by keys.
  (define (remove-options options keys)
    (let loop ([o options])
      (cond [(or (null? o) (null? (cdr o))) '()]
            [(memq (car o) keys) (loop (cddr o))]
            [else (cons* (car o) (cadr o) (loop (cddr o)))])))

  (define (stagger step . options)
    (let ([from (option options 'from 'first)] [start (option options 'start 0)])
      (lambda (i n)
        (+ start (* step (case from
                           [(last) (- n 1 i)]
                           [(center) (abs (- i (/ (- n 1) 2)))]
                           [else i]))))))

  ;; A timeline: animations added one after another, each by default where
  ;; the last ends; defaults (timing options) for those added. It plays at
  ;; once, unless 'autoplay #f.
  (define (timeline . defaults)
    (let ([tl (make-animation '() (anim-now) #f #f (option defaults 'on-complete #f) 0
                              (remove-options defaults '(on-complete autoplay)))])
      (when (option defaults 'autoplay #t) (play! tl))
      tl))

  ;; Add an animation of targets to `to` to timeline tl: at its end, or
  ;; where 'offset says -- a number (from its start), or "+=n" or "-=n"
  ;; (from its end). Returns tl.
  (define (timeline-add! tl targets to . options)
    (let* ([options (append options (animation-defaults tl))]
           [end (animation-length tl)]
           [offset (option options 'offset #f)]
           [base (cond [(number? offset) offset]
                       [(and (string? offset) (string-prefix? "+=" offset))
                        (+ end (string->number (substring offset 2 (string-length offset))))]
                       [(and (string? offset) (string-prefix? "-=" offset))
                        (- end (string->number (substring offset 2 (string-length offset))))]
                       [else end])]
           [parts (tween-parts targets to options base)]
           [ends (map (lambda (p)
                        (let ([n (tween-timing (cdr p))])
                          (+ (car p) (list-ref n 1) (* (list-ref n 0) (max 1 (list-ref n 3))) (list-ref n 2))))
                      parts)])
      (animation-parts-set! tl (append (animation-parts tl) parts))
      (animation-length-set! tl (apply max end ends))
      (when (and (memq tl running) (not (moving?))) (advance! tl))
      tl))

  (define (animation-pause! a)
    (unless (animation-paused a) (animation-paused-set! a (anim-now))))
  (define (animation-play! a)
    (when (animation-paused a)
      (animation-start-set! a (+ (animation-start a) (- (anim-now) (animation-paused a))))
      (animation-paused-set! a #f))
    (animation-done?-set! a #f)
    (play! a))
  (define (animation-restart! a)
    (animation-start-set! a (anim-now))
    (animation-paused-set! a #f)
    (animation-done?-set! a #f)
    (play! a))
  ;; Go to ms into the animation, and show it there.
  (define (animation-seek! a ms)
    (let ([now (anim-now)])
      (animation-start-set! a (- (or (animation-paused a) now) ms))
      (advance! a)))
  (define (animation-finished? a) (animation-done? a))
  (define (animations-running?) (pair? running))

  ;; ---------------------------------------------------------------------------
  ;; Effects

  ;; kind: a symbol (sheen); params: four numbers, the kind's; color:
  ;; #xRRGGBB; timing: ten numbers; start: when it began, on the clock.
  (define-record-type effect-object
    (fields id kind params color timing (mutable start))
    (nongenerative))
  (define (effect? x) (effect-object? x))
  (define (effect-id e) (effect-object-id e))
  (define (effect-kind e) (effect-object-kind e))
  (define (effect-params e) (effect-object-params e))
  (define (effect-color e) (effect-object-color e))
  (define (effect-timing e) (effect-object-timing e))
  (define (effect-restart! e) (effect-object-start-set! e (anim-now)))
  (define (effect-age e) (- (anim-now) (effect-object-start e)))

  (define (effect-kind-number e) (case (effect-kind e) [(sheen) 1] [else 0]))

  (define next-effect-id 0)

  ;; An effect of kind, with options: the timing's (as animate! takes
  ;; them), and the kind's -- for a sheen, angle (degrees from across,
  ;; positive down: 20), width (its band's half-width, in cells: 3),
  ;; intensity (at its middle, 0 to 1: 0.55), color (#xffffff).
  (define (effect kind . options)
    (set! next-effect-id (+ next-effect-id 1))
    (case kind
      [(sheen)
       (make-effect-object next-effect-id kind
                           (map inexact (list (option options 'angle 20) (option options 'width 3)
                                              (option options 'intensity 0.55) 0))
                           (option options 'color #xffffff)
                           (timing-numbers (append options '(duration 1400 easing in-out-sine))
                                           (option options 'delay 0))
                           (anim-now))]
      [else (errorf 'effect "no effect of kind ~s" kind)]))

  ;; Its progress now (0 where it stands still).
  (define (effect-progress e)
    (if (moving?) (fx-progress (effect-timing e) (inexact (max 0 (effect-age e)))) 0.0))
  (define (effect-next-change e)
    (and (moving?) (fx-next-change (effect-timing e) (inexact (max 0 (effect-age e))))))

  ;; Ink (#xRRGGBB) at (x, y) in a rectangle w by h, in cell widths.
  (define (effect-shade e x y w h ink)
    (fx-shade (effect-kind-number e) (effect-params e) (effect-color e) (effect-progress e)
              (inexact x) (inexact y) (inexact w) (inexact h) ink))

  ;; Widget w, with effect e over the cells it draws.
  (define (with-effect w e)
    (make-widget
     (lambda (cols) (widget-rows w cols))
     (lambda (g row col rows cols)
       (let ([cursor (widget-draw! w g row col rows cols)]
             [height (min rows (widget-rows w cols))])
         (when (> height 0)
           (grid-effects-set! g (cons (list e row col height cols) (grid-effects g))))
         cursor))))

  ;; ---------------------------------------------------------------------------
  ;; Frames: when the loop should wake to draw

  ;; Effects a client of the editor's drawing (not a window, which times
  ;; its own) showed in the frames last drawn.
  (define shown '())
  (define (anim-render-begin!) (set! shown '()))
  (define (anim-effect-shown! e) (unless (memq e shown) (set! shown (cons e shown))))

  (define last-tick 0)

  ;; Milliseconds until the next frame is due, or -1 for none: the next
  ;; frame (animation-fps) while anything plays (paused ones do not move),
  ;; else when the next shown effect next changes.
  (define (anim-timeout)
    (let* ([interval (/ 1000.0 (max 1 (get-var 'animation-fps #f)))]
           [frame (max 0 (exact (ceiling (- (+ last-tick interval) (anim-now)))))]
           [waits (filter-map (lambda (e)
                                (let ([n (effect-next-change e)])
                                  (and n (if (<= n 0) frame (exact (ceiling n))))))
                              shown)])
      (cond
       [(exists (lambda (a) (not (animation-paused a))) running) frame]
       [(pair? waits) (apply min waits)]
       [else -1])))

  ;; Move everything playing to where it is now.
  (define (anim-tick!)
    (set! last-tick (anim-now))
    (for-each (lambda (a)
                (unless (or (animation-paused a) (advance! a))
                  (finish! a)))
              running)))
