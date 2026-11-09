;; golden.ss -- what the window draws, against images of it kept as golden
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Scenes of the editor, drawn as the window draws them but with no window
;; (as tests/gui-render.ss draws them), with the built-in font alone (so no
;; machine's fonts change them) on Mesa's lavapipe, and compared with the
;; images in tests/golden: any change to how something is drawn shows. A
;; pixel differs when a channel is more than `tolerance` off, as lavapipe's
;; antialiasing may be from version to version, and a few may. On macOS
;; the scenes are drawn with Metal instead, on the Mac's GPU, and come out
;; within a level or two of lavapipe's. Where a scene differs, what was
;; drawn and where it differs (in red) are written to $TMPDIR as PNGs, to
;; look at.
;;
;; QUAD_GOLDEN names the directory of golden images (tests/gui-render.sh
;; sets it). After a change meant to change them, draw them again, from
;; tilde/aseipp/quad, on Linux:
;;
;;   QUAD_GUI_DEVICE=llvmpipe QUAD_GOLDEN=tests/golden QUAD_GOLDEN_UPDATE=1 \
;;     $(buck2 build --show-full-simple-output :quad) -q --batch tests/golden.ss
;;
;; and look at what changed before committing them.

(define golden-dir (or (getenv "QUAD_GOLDEN") "tests/golden"))
(define update? (equal? (getenv "QUAD_GOLDEN_UPDATE") "1"))

(define h (headless-gpu "JetBrains Mono" 12 #f))
(define device (caddr (gui-headless-info h)))
(unless (or (string-contains device "llvmpipe") macos?)
  (printf "SKIP: golden images are drawn with lavapipe (or Metal), not ~a\n" device)
  (exit 0))
(printf "drawing with ~a\n" device)

(define rows 16)
(define cols 56)
(headless-start! rows cols)

;; A channel this far off makes a pixel differ; this many may.
(define tolerance 48)
(define (allowed pixels) (max 8 (quotient pixels 2000)))

(define (out-path name what)
  (format "~a/quad-golden-~a-~a.png" (or (getenv "TMPDIR") "/tmp") name what))

;; How many pixels of a and b (RGBA) differ, and by how much at most; and
;; the picture of where: those that differ red, the rest dimmed.
(define (differences a b)
  (let ([n (bytevector-length a)] [where (bytevector-copy b)])
    (let loop ([i 0] [bad 0] [worst 0])
      (if (= i n)
          (values bad worst where)
          (let ([d (max (abs (- (bytevector-u8-ref a i) (bytevector-u8-ref b i)))
                        (abs (- (bytevector-u8-ref a (+ i 1)) (bytevector-u8-ref b (+ i 1))))
                        (abs (- (bytevector-u8-ref a (+ i 2)) (bytevector-u8-ref b (+ i 2)))))])
            (if (> d tolerance)
                (begin (bytevector-u8-set! where i 255)
                       (bytevector-u8-set! where (+ i 1) 0)
                       (bytevector-u8-set! where (+ i 2) 0))
                (do ([c 0 (+ c 1)]) ((= c 3))
                  (bytevector-u8-set! where (+ i c) (quotient (bytevector-u8-ref where (+ i c)) 3))))
            (loop (+ i 4) (if (> d tolerance) (+ bad 1) bad) (max worst d)))))))

;; Draws `model` and compares it with the golden image `name`, or writes
;; it as that, when updating.
(define (scene! name model)
  (let-values ([(w ht px) (draw-frame-image h model)])
    (let ([path (string-append golden-dir "/" name ".png")])
      (if update?
          (begin (png-file-write path w ht px) (printf "wrote ~a\n" path))
          (let ([want (guard (e [#t (printf "  ~a\n" (if (condition? e) (condition->string e) e)) #f])
                        (png-file-read path w ht))])
            (check (string-append name ": there is a golden image of its size") want)
            (when want
              (let-values ([(bad worst where) (differences want px)])
                (let ([ok (<= bad (allowed (* w ht)))])
                  (unless ok
                    (png-file-write (out-path name "drawn") w ht px)
                    (png-file-write (out-path name "where") w ht where)
                    (printf "  ~a pixels differ, by up to ~a: see ~a and ~a\n" bad worst
                            (out-path name "drawn") (out-path name "where")))
                  (check (string-append name ": drawn as its golden image") ok)))))))))

;; A client keeping a grid model, as a window does, showing `buffer`.
(define (viewer buffer)
  (let-values ([(c model) (model-client! "gui" rows cols '())])
    (with-client c (lambda () (switch-to-buffer! buffer)))
    (redraw!)
    (values c model)))

;; ---------------------------------------------------------------------------
;; Code: highlighted, numbered, with the cursor and the status line.

(define code
  (headless-buffer!
   (string-append
    ";; The Fibonacci numbers, slowly.\n"
    "(define (fib n)\n"
    "  (if (< n 2)\n"
    "      n\n"
    "      (+ (fib (- n 1)) (fib (- n 2)))))\n"
    "\n"
    "(display (map fib '(0 1 2 3 4 5 6 7 8 9 10)))\n"
    "(newline) ; \"done\" -> 55\n")
   'scheme))
(let-values ([(c model) (viewer code)])
  (scene! "code" model)

  ;; -------------------------------------------------------------------------
  ;; A picker over it, framed in box drawing.
  (with-client c (lambda () (pick "Pick one" '(("alpha" . 1) ("beta" . 2) ("gamma" . 3)) void)))
  (redraw!)
  (scene! "picker" model)
  (with-client c (lambda () (run-command 'prompt-cancel))))

;; ---------------------------------------------------------------------------
;; Text in every style: weights and slants, each kind of underline (one in
;; its own color), lines through and over, faint and reversed.

(define styles
  (headless-buffer!
   "regular\nbold\nitalic\nbold italic\nunderline\ndouble underline\ncurly red underline\ndotted underline\ndashed underline\nstrikethrough\noverline\ndim\nreverse\n"
   'fundamental))
;; make-face: fg bg bold? italic? underline-style dim? reverse? underline-color strikethrough? overline?
(define line-faces
  (list #f
        (make-face #f #f #t #f #f #f #f #f #f #f)
        (make-face #f #f #f #t #f #f #f #f #f #f)
        (make-face #f #f #t #t #f #f #f #f #f #f)
        (make-face #f #f #f #f 'single #f #f #f #f #f)
        (make-face #f #f #f #f 'double #f #f #f #f #f)
        (make-face #f #f #f #f 'curly #f #f #xff4040 #f #f)
        (make-face #f #f #f #f 'dotted #f #f #f #f #f)
        (make-face #f #f #f #f 'dashed #f #f #f #f #f)
        (make-face #f #f #f #f #f #f #f #f #t #f)
        (make-face #f #f #f #f #f #f #f #f #f #t)
        (make-face #f #f #f #f #f #t #f #f #f #f)
        (make-face #f #f #f #f #f #f #t #f #f #f)))
(add-decorator!
 (lambda (b start end)
   (if (not (eq? b styles))
       '()
       (let ([s (buffer-string b)])
         (let loop ([i 0] [line 0] [from 0] [out '()])
           (cond
            [(= i (string-length s)) out]
            [(char=? (string-ref s i) #\newline)
             (let ([f (and (< line (length line-faces)) (list-ref line-faces line))])
               (loop (+ i 1) (+ line 1) (+ i 1) (if f (cons (list from i f) out) out)))]
            [else (loop (+ i 1) line from out)]))))))
(let-values ([(c model) (viewer styles)])
  (scene! "styles" model))
