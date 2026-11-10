;; display.sls -- drawing what each client shows
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The server draws each client's frame -- its view, status line, prompt,
;; legend and pickers -- into a grid of cells the size of the client's
;; screen, compares it with the client's previous frame, and sends the
;; changed cells as protocol messages (see protocol.sls): "hl" for each new
;; highlight, "line" for each changed run of cells, "cursor", then "flush".
;; Clients draw cells however they draw: the terminal client with escape
;; sequences, a graphical one with its own renderer. Cells hold a character
;; (or a string, for a character with combining marks) and an interned face.
;;
;; A frame can place images (pictures) over rectangles of cells, for
;; clients that can draw them ("images"): each is sent once ("image"),
;; and the frame's placements whenever they change ("images").
(library (quad display)
  (export render-client! invalidate-client! define-status-segment! status-segments
          define-gutter! remove-gutter! gutter-names
          face-id add-decorator! remove-decorator! add-view-decorator! remove-view-decorator!
          define-buffer-drawer!
          make-picture picture? picture-key picture-width picture-height picture-png
          place-picture! put-string! ui-face fill-row! grid-rows grid-cols)
  (import (chezscheme) (quad util) (quad text) (quad face) (quad anim) (quad color)
          (only (quad native) fx-raster blake3)
          (quad syntax) (quad buffer) (quad selection) (quad editor) (quad canvas) (quad widget))

  ;; ---------------------------------------------------------------------------
  ;; Pictures: images over cells
  ;;
  ;; A picture is a PNG, its size in pixels, and a key naming it: a hash
  ;; of it, so that a client that has it under that key, from any editor,
  ;; has this one.
  (define-record-type picture (fields key width height png))

  ;; The cells under a picture: blank, in a face of their own, so that
  ;; whatever is drawn over them later shows in their place.
  (define placeholder-faces (make-weak-eq-hashtable))
  (define (placeholder-face)
    (let ([base (F 'ui)])
      (or (hashtable-ref placeholder-faces base #f)
          (let ([f (make-face (face-fg base) (face-bg base))])
            (hashtable-set! placeholder-faces base f)
            f))))

  ;; Place picture p over rows by cols cells from (row, col); clients fit
  ;; it in them.
  (define (place-picture! g p row col rows cols)
    (let ([face (placeholder-face)])
      (do ([r row (+ r 1)]) ((= r (+ row rows)))
        (fill-row! g r col (+ col cols) face))
      (grid-images-set! g (cons (list p row col rows cols) (grid-images g)))))

  ;; How many of a placement's rows, from its top, nothing was drawn over.
  (define (rows-shown g row col rows cols)
    (let ([face (placeholder-face)] [end (min (+ col cols) (grid-cols g))])
      (let loop ([r 0])
        (if (and (< r rows) (< (+ row r) (grid-rows g))
                 (let all ([c col])
                   (or (>= c end)
                       (and (eqv? (vector-ref (vector-ref (grid-chars g) (+ row r)) c) #\space)
                            (eq? (face-at g (+ row r) c) face)
                            (all (+ c 1))))))
            (loop (+ r 1))
            r))))

  ;; The frame's placements, as "images" has them, and their pictures:
  ;; those with some rows to show.
  (define (frame-pictures g)
    (filter (lambda (p) (> (list-ref (car p) 5) 0))
            (map (lambda (i)
                   (let ([p (car i)] [row (cadr i)] [col (caddr i)] [rows (cadddr i)] [cols (list-ref i 4)])
                     (cons (list (picture-key p) row col rows cols (rows-shown g row col rows cols)) p)))
                 (reverse (grid-images g)))))

  ;; ---------------------------------------------------------------------------
  ;; Effects (anim.sls; docs/animation.md)
  ;;
  ;; Each client draws the effects placed in its frame as best it can: a
  ;; window ("effects") itself, told of them once (send-frame!), timing them
  ;; at its display's rate; a terminal that shows images, as pictures the
  ;; editor draws of them (kernel/fx's raster), a frame at each step of
  ;; their progress, each made once and kept by the terminal; any other, or
  ;; one whose cells the raster cannot draw, by its cells' colors. Points
  ;; are in cell widths, a terminal's cells taken as twice as tall as wide.

  (define (effect-signature p) (cons (effect-id (car p)) (cdr p)))

  ;; As "effects" has each: (id kind row col rows cols color (params) age
  ;; (timing)), age in milliseconds.
  (define (effect-message p)
    (let ([e (car p)])
      (list (effect-id e) (effect-kind-number e) (cadr p) (caddr p) (cadddr p) (list-ref p 4)
            (effect-color e) (effect-params e) (inexact (effect-age e)) (effect-timing e))))

  (define (draw-effects! c g)
    (unless (or (client-has? c "effects") (not (get-var 'animations #f)))
      (for-each (lambda (p)
                  (anim-effect-shown! (car p))
                  (unless (and (client-has? c "images") (effect-picture! g p))
                    (shade-cells! g p)))
                (grid-effects g))))

  ;; Progress in steps: so many frames to an iteration at most, each drawn
  ;; once, and the same each time round.
  (define steps 64)
  (define (stepped e) (/ (round (* steps (effect-progress e))) steps))

  ;; Face f with foreground fg: over f, a face of fg alone, one for each
  ;; color, which face-merge's interning makes one face for each f too.
  (define fg-faces (make-eqv-hashtable))
  (define (shaded-face f fg)
    (face-merge f (or (hashtable-ref fg-faces fg #f)
                      (let ([top (make-face fg #f)]) (hashtable-set! fg-faces fg top) top))))

  ;; Effect placement p over g's cells as their inks: all shaded at once,
  ;; and those that change put back.
  (define (shade-cells! g p)
    (let* ([e (car p)] [row (cadr p)] [col (caddr p)] [rows (cadddr p)] [cols (list-ref p 4)]
           [shown-rows (max 0 (min rows (- (grid-rows g) row)))]
           [shown-cols (max 0 (min cols (- (grid-cols g) col)))]
           [inks (make-bytevector (* 4 rows cols) #xff)]
           [at (lambda (r k) (* 4 (+ k (* r cols))))])
      (do ([r 0 (+ r 1)]) ((= r shown-rows))
        (do ([k 0 (+ k 1)]) ((= k shown-cols))
          (let ([fg (face-fg (face-at g (+ row r) (+ col k)))])
            (when fg (bytevector-u32-native-set! inks (at r k) (color-rgb fg))))))
      (let ([shaded (effect-shade-cells e (stepped e) cols rows inks)])
        (do ([r 0 (+ r 1)]) ((= r shown-rows))
          (do ([k 0 (+ k 1)]) ((= k shown-cols))
            (let ([new (bytevector-u32-native-ref shaded (at r k))])
              (unless (= new (bytevector-u32-native-ref inks (at r k)))
                (put! g (+ row r) (+ col k) (vector-ref (vector-ref (grid-chars g) (+ row r)) (+ col k))
                      (shaded-face (face-at g (+ row r) (+ col k)) new)))))))))

  ;; Pictures of effects, by key: their cells, the effect, and its step.
  ;; Keyed by all they are drawn from, (id cols step texts colors), and
  ;; named by their PNGs.
  (define effect-pictures (make-hashtable equal-hash equal?))
  (define effect-cell '(16 . 32))

  ;; Draw effect placement p over g's cells as a picture; #f where it
  ;; cannot (a cell with no colors of its own, or a character the raster
  ;; does not draw).
  (define (effect-picture! g p)
    (let* ([e (car p)] [row (cadr p)] [col (caddr p)]
           [rows (min (cadddr p) (- (grid-rows g) row))] [cols (min (list-ref p 4) (- (grid-cols g) col))])
      (and (> rows 0) (> cols 0)
           (let-values ([(texts colors) (effect-cells g row col rows cols)])
             (and texts
                  (let* ([progress (stepped e)]
                         [key (list (effect-id e) cols (exact (round (* steps progress))) texts colors)]
                         [pic (or (hashtable-ref effect-pictures key #f)
                                  (let ([png (fx-raster texts colors cols (car effect-cell) (cdr effect-cell)
                                                        (effect-kind-number e) (effect-params e) (effect-color e)
                                                        (inexact progress))])
                                    (and png
                                         (let ([pic (make-picture (string-append "fx:" (bytevector->hex (blake3 png)))
                                                                  (* cols (car effect-cell)) (* rows (cdr effect-cell))
                                                                  png)])
                                           (when (> (hashtable-size effect-pictures) 512)
                                             (hashtable-clear! effect-pictures))
                                           (hashtable-set! effect-pictures key pic)
                                           pic))))])
                    (and pic (begin (place-picture! g pic row col rows cols) #t))))))))

  ;; The texts of the rows by cols cells of g at (row, col), row by row,
  ;; and their colors, each one's foreground then background (#xRRGGBB);
  ;; #f and #f if one has no colors of its own.
  (define (effect-cells g row col rows cols)
    (let loop ([r (- rows 1)] [k (- cols 1)] [texts '()] [colors '()])
      (cond
       [(< r 0) (values texts colors)]
       [(< k 0) (loop (- r 1) (- cols 1) texts colors)]
       [else
        (let* ([f (face-at g (+ row r) (+ col k))] [fg (face-fg f)] [bg (face-bg f)])
          (if (and fg bg)
              (loop r (- k 1)
                    (cons (cell-text (vector-ref (vector-ref (grid-chars g) (+ row r)) (+ col k))) texts)
                    (cons (color-rgb fg) (cons (color-rgb bg) colors)))
              (values #f #f)))])))

  ;; ---------------------------------------------------------------------------
  ;; Output: frames as messages

  ;; Faces get small integer ids, the same for every client; each client is
  ;; told an id's colors ("hl") before its first use.
  (define face-ids (make-eq-hashtable))
  (define (face-id f)
    (or (hashtable-ref face-ids f #f)
        (let ([id (+ 1 (hashtable-size face-ids))])
          (hashtable-set! face-ids f id)
          id)))

  (define (face-flags f)
    (logior (if (face-bold? f) 1 0) (if (face-italic? f) 2 0)
            (case (face-underline-style f)
              [(single) 4] [(curly) 8] [(double) 64] [(dotted) 128] [(dashed) 256] [else 0])
            (if (face-dim? f) 16 0) (if (face-reverse? f) 32 0)
            (if (face-strikethrough? f) 512 0) (if (face-overline? f) 1024 0)))

  ;; The client's state between frames: the grid it shows and the ids it
  ;; knows.
  ;; scroll: (top bottom buffer line), the text area's rows and what they
  ;; showed, for scroll hints; or #f. images: the placements it was sent.
  ;; effects: those a window was sent, each (id row col rows cols).
  (define-record-type frame (fields grid known cursor scroll images effects))

  ;; prev with rows top to bottom moved up by n (down, for n < 0), as a
  ;; client that scrolls them has them; rows scrolled in match no cell.
  (define (scrolled-grid prev top bottom n)
    (let ([chars (vector-copy (grid-chars prev))] [faces (vector-copy (grid-faces prev))]
          [cols (grid-cols prev)])
      (do ([r top (+ r 1)]) ((= r bottom))
        (let ([from (+ r n)])
          (if (and (>= from top) (< from bottom))
              (begin (vector-set! chars r (vector-ref (grid-chars prev) from))
                     (vector-set! faces r (vector-ref (grid-faces prev) from)))
              (begin (vector-set! chars r (make-vector cols #f))
                     (vector-set! faces r (make-vector cols #f))))))
      (make-grid (grid-rows prev) cols chars faces '() '())))

  ;; Forget what client c shows, so the next frame redraws it whole.
  (define (invalidate-client! c) (client-frame-set! c #f))

  (define (cell-text ch) (cond [(char? ch) (string ch)] [(string? ch) ch] [else ""]))

  ;; The cells of row r from c0 to c1, as Neovim's grid_line has them:
  ;; (text hl repeat), with repeat left out when it is 1, and hl too when it
  ;; is the previous cell's. Each run of cells with the same text and face
  ;; is looked at once (faces are interned, so the same face is eq?).
  (define (row-cells g r c0 c1 hl!)
    (let ([chars (vector-ref (grid-chars g) r)] [faces (vector-ref (grid-faces g) r)])
      (let loop ([c c0] [last-hl #f] [out '()])
        (if (>= c c1)
            (reverse out)
            (let* ([ch (vector-ref chars c)] [f (vector-ref faces c)] [text (cell-text ch)] [hl (hl! f)]
                   ;; Two characters are the same text only if they are one.
                   [same? (lambda (x)
                            (or (equal? x ch)
                                (and (not (and (char? x) (char? ch))) (string=? (cell-text x) text))))]
                   [end (let run ([k (+ c 1)])
                          (if (and (< k c1) (eq? (vector-ref faces k) f) (same? (vector-ref chars k)))
                              (run (+ k 1))
                              k))]
                   [n (- end c)])
              (loop end hl (cons (cond [(> n 1) (list text hl n)]
                                       [(eqv? hl last-hl) (list text)]
                                       [else (list text hl)])
                                 out)))))))

  ;; How many lines the text area moved since the frame old, when the
  ;; client can scroll its rows ("scroll") to match: scroll is the text
  ;; area, as frame-scroll has it, and it must show the same buffer, moved
  ;; by fewer lines than it has. Else #f.
  (define (frame-shift c old scroll)
    (let ([was (and old (frame-scroll old))])
      (and scroll was (client-has? c "scroll")
           (= (car scroll) (car was)) (= (cadr scroll) (cadr was)) (eq? (caddr scroll) (caddr was))
           (let ([n (- (cadddr scroll) (cadddr was))])
             (and (not (zero? n)) (< (abs n) (- (cadr scroll) (car scroll))) n)))))

  ;; The first and last columns of row r where g and prev differ, or #f
  ;; and #f; the whole row when there is no prev.
  (define (changed-span g prev r)
    (if (not prev)
        (values 0 (- (grid-cols g) 1))
        (let ([chars (vector-ref (grid-chars g) r)] [faces (vector-ref (grid-faces g) r)]
              [pchars (vector-ref (grid-chars prev) r)] [pfaces (vector-ref (grid-faces prev) r)])
          (let loop ([i 0] [first #f] [last #f])
            (cond
             [(= i (grid-cols g)) (values first last)]
             [(and (equal? (vector-ref chars i) (vector-ref pchars i))
                   (eq? (vector-ref faces i) (vector-ref pfaces i)))
              (loop (+ i 1) first last)]
             [else (loop (+ i 1) (or first i) i)])))))

  ;; Send client c the rows of g that differ from prev (all of them, with
  ;; no prev), each from its first changed cell; hl! names each cell's face.
  ;; Returns whether any did.
  (define (send-rows! c g prev hl!)
    (let loop ([r 0] [changed? #f])
      (if (= r (grid-rows g))
          changed?
          (let-values ([(first last) (changed-span g prev r)])
            (when first
              ;; Never start on the right half of a wide character.
              (let ([first (if (and (> first 0) (eq? (vector-ref (vector-ref (grid-chars g) r) first) 'wide))
                               (- first 1)
                               first)])
                (client-send! c (list "line" r first (row-cells g r first (+ last 1) hl!)))))
            (loop (+ r 1) (or changed? (and first #t)))))))

  ;; Send client c each picture it has not had (it keeps them), then where
  ;; they all are.
  (define (send-pictures! c pictures)
    (let ([sent (or (client-local c 'pictures #f)
                    (let ([h (make-hashtable string-hash string=?)]) (client-local-set! c 'pictures h) h))])
      (for-each (lambda (p)
                  (let ([pic (cdr p)])
                    (unless (hashtable-contains? sent (picture-key pic))
                      (hashtable-set! sent (picture-key pic) #t)
                      (client-send! c (list "image" (picture-key pic) (picture-width pic)
                                            (picture-height pic) (picture-png pic))))))
                pictures)
      (client-send! c (list "images" (map car pictures)))))

  ;; Send client c what of frame g (with cursor, and the text area scroll,
  ;; for frame-shift) differs from what it shows; nothing, when nothing
  ;; does.
  (define (send-frame! c g cursor scroll)
    (let* ([cursor (and cursor (or (not (eq? (caddr cursor) 'hidden)) (client-has? c "hidden-cursor"))
                        cursor)]
           ;; What it shows, if it is a grid of this size.
           [old (let ([o (client-frame c)])
                  (and o (= (grid-rows (frame-grid o)) (grid-rows g)) (= (grid-cols (frame-grid o)) (grid-cols g))
                       o))]
           [known (if old (frame-known old) (make-eqv-hashtable))]
           [shift (frame-shift c old scroll)]
           [prev (and old (if shift
                              (scrolled-grid (frame-grid old) (car scroll) (cadr scroll) shift)
                              (frame-grid old)))]
           [images? (client-has? c "images")]
           [effects? (client-has? c "effects")]
           [pictures (if images? (frame-pictures g) '())]
           [placed (map car pictures)]
           [effects (if (and effects? (get-var 'animations #f)) (reverse (grid-effects g)) '())]
           [signatures (map effect-signature effects)]
           [hl! (lambda (f)
                  (let ([id (face-id f)])
                    (unless (hashtable-contains? known id)
                      (hashtable-set! known id #t)
                      (client-send! c (list "hl" id (face-fg f) (face-bg f) (face-flags f)
                                            (face-underline-color f) (face-link f))))
                    id))])
      (unless old (client-send! c (list "grid" (grid-rows g) (grid-cols g))))
      (when shift (client-send! c (list "scroll" (car scroll) (cadr scroll) shift)))
      (let* ([rows? (send-rows! c g prev hl!)]
             ;; A terminal forgets its pictures on "grid".
             [pictures? (and images? (or (not old) (not (equal? placed (frame-images old)))))]
             [effects? (and effects? (not (equal? signatures (if old (frame-effects old) '()))))])
        (when pictures? (send-pictures! c pictures))
        (when effects? (client-send! c (list "effects" (map effect-message effects))))
        ;; A frame like the last is not sent: clients draw only what changed.
        (when (or (not old) shift rows? pictures? effects? (not (equal? cursor (frame-cursor old))))
          (client-send! c (if cursor (list "cursor" (car cursor) (cadr cursor) (symbol->string (caddr cursor)))
                              '("cursor" #f)))
          (client-send! c '("flush"))))
      (client-frame-set! c (make-frame g known cursor scroll placed signatures))))

  ;; ---------------------------------------------------------------------------
  ;; The text area

  (define (head-position v s)
    (if (view-cursor-start? v)
        (sel-range-start s)
        (max (sel-range-start s) (- (sel-range-end s) 1))))

  (define (scroll-into-view! v height width gutter)
    (unless (view-local v 'free-scroll #f)
      (let* ([b (view-buffer v)]
             [t (buffer-text b)]
             [p (view-primary v)]
             [head (if (eq? (view-input-mode v) 'insert) (sel-start p) (head-position v p))]
             [line (text-line-of t head)]
             [margin (min (get-var 'scroll-margin b) (quotient (- height 1) 2))]
             [top (view-top v)])
        (cond
         [(< line (+ top margin)) (view-top-set! v (max 0 (- line margin)))]
         [(> line (- (+ top height) 1 margin)) (view-top-set! v (max 0 (+ (- line height) 1 margin)))])
        (let ([col (display-column b head)] [left (view-left v)] [w (- width gutter)])
          (cond
           [(< col left) (view-left-set! v (max 0 (- col 4)))]
           [(>= col (+ left w -1)) (view-left-set! v (+ (- col w) 5))])))))

  ;; The views of v's buffer that other people are looking at.
  (define (others-views v)
    (filter (lambda (o)
              (let ([c (view-client o)])
                (and (not (eq? o v)) (memq c (clients)) (person? c) (eq? (client-view c) o))))
            (buffer-views (view-buffer v))))

  (define (peer-face c part)
    (F (string->symbol (format "ui.peer.~a.~a" (client-color c) part))))

  ;; Overlay faces per position on lines from line-start to line-end (the
  ;; last's newline): selections and cursors, under the other people's
  ;; (`others`, their views of the same buffer), each in their color.
  (define (selection-spans v others line-start line-end)
    (let ([insert? (eq? (view-input-mode v) 'insert)]
          [others (apply append
                         (map (lambda (o)
                                (let ([c (view-client o)])
                                  (apply append
                                         (map (lambda (s)
                                                (let ([rs (sel-range-start s)] [re (sel-range-end s)]
                                                      [h (head-position o s)])
                                                  (append
                                                   (if (and (< rs re) (<= rs (+ line-end 1)) (>= re line-start)
                                                            (not (eq? (view-input-mode o) 'insert)))
                                                       (list (list (max rs line-start) (min re (+ line-end 1))
                                                                   (peer-face c 'selection)))
                                                       '())
                                                   (if (<= line-start h (+ line-end 1))
                                                       (list (list h (+ h 1) (peer-face c 'cursor)))
                                                       '()))))
                                              (view-sels o)))))
                              others))])
      (let loop ([sels (view-sels v)] [primary? #t] [acc others])
        (if (null? sels)
            acc
            (let* ([s (car sels)] [rs (sel-range-start s)] [re (sel-range-end s)]
                   [head (head-position v s)]
                   [acc (if (and (not insert?) (< rs re) (<= rs (+ line-end 1)) (>= re line-start))
                            (cons (list (max rs line-start) (min re (+ line-end 1))
                                        (F (if primary? 'ui.selection 'ui.selection.secondary)))
                                  acc)
                            acc)]
                   [acc (if (and (<= line-start head (+ line-end 1))
                                 (or (not insert?) (not primary?)))
                            (cons (list head (+ head 1) (F (if primary? 'ui.cursor.primary 'ui.cursor))) acc)
                            acc)])
              (loop (cdr sels) #f acc))))))

  ;; The bracket matching the one at the primary head, if any, by a scan
  ;; of at most 20000 characters that counts brackets of its kind.
  (define (matching-bracket v)
    (let* ([t (buffer-text (view-buffer v))] [p (view-primary v)] [pos (head-position v p)] [n (text-length t)])
      (and (< pos n)
           (let* ([c (text-ref t pos)]
                  [pair (assv c '((#\( #\) 1) (#\[ #\] 1) (#\{ #\} 1) (#\) #\( -1) (#\] #\[ -1) (#\} #\{ -1)))])
             (and pair
                  (let ([other (cadr pair)] [step (caddr pair)])
                    (let loop ([i (+ pos step)] [depth 0] [budget 20000])
                      (cond
                       [(or (< i 0) (>= i n) (= budget 0)) #f]
                       [(char=? (text-ref t i) c) (loop (+ i step) (+ depth 1) (- budget 1))]
                       [(char=? (text-ref t i) other)
                        (if (= depth 0) i (loop (+ i step) (- depth 1) (- budget 1)))]
                       [else (loop (+ i step) depth (- budget 1))]))))))))

  ;; Draw buffer line [s, e] (e is its newline) into row, from text column
  ;; `left`, starting at screen column `gutter`; returns the screen column
  ;; its newline is at (past width, if the line is cut off before it).
  (define (draw-line! g b row s e gutter width left row-face syntax-spans overlays match tw ws?)
    (let ([t (buffer-text b)])
      (define (face-for i ss)
        (let* ([syn (and (pair? ss) (<= (car (car ss)) i) (< i (cadr (car ss))) (F (caddr (car ss))))]
               [f (if syn (face-merge row-face syn) row-face)]
               [f (if (and match (= i match)) (face-merge f (F 'ui.cursor.match)) f)])
          (fold-left (lambda (f o) (if (and (<= (car o) i) (< i (cadr o))) (face-merge f (caddr o)) f))
                     f overlays)))
      (define (visible? sc) (and (>= sc gutter) (< sc width)))
      (define (ref i) (text-ref t i))
      (let loop ([i s] [col 0] [ss syntax-spans])
        (let ([ss (let skip ([ss ss]) (if (and (pair? ss) (<= (cadr (car ss)) i)) (skip (cdr ss)) ss))]
              [sc (+ gutter (- col left))])
          (cond
           [(= i e)
            ;; The newline: a space, so a selection or a cursor on it shows.
            (when (visible? sc) (put! g row sc #\space (face-for i ss)))
            sc]
           ;; Past the right edge (where a mark may still join the last
           ;; cell): nothing more shows.
           [(> sc width) sc]
           [else
            ;; A grapheme cluster: a character and what extends it. Its
            ;; face is found only where it shows.
            (let* ([ch (text-ref t i)]
                   [tab? (char=? ch #\tab)]
                   [j (if tab? (+ i 1) (grapheme-end ref i e))]
                   [w (if tab? (- tw (modulo col tw)) (grapheme-columns ref i j))]
                   [ch (if (= j (+ i 1)) ch (text-substring t i j))]
                   [face (lambda () (face-for i ss))])
              (cond
               [(= w 0)
                ;; Marks with nothing to mark (after a tab, at the line's
                ;; start) join the cell before them.
                (let ([pc (- sc 1)])
                  (when (visible? pc)
                    (let ([prev (vector-ref (vector-ref (grid-chars g) row) pc)])
                      (put! g row pc
                            (string-append (cell-text prev) (cell-text ch))
                            (face-at g row pc)))))]
               [tab?
                (let ([f (and (< sc width) (> (+ sc w) gutter)
                              (if ws? (face-merge (face) (F 'ui.virtual.whitespace)) (face)))])
                  (do ([k 0 (+ k 1)]) ((= k w))
                    (when (visible? (+ sc k))
                      (put! g row (+ sc k) (if (and ws? (= k 0)) #\→ #\space) f))))]
               [(= w 2)
                (when (visible? sc)
                  (let ([f (face)])
                    (if (visible? (+ sc 1))
                        (begin (put! g row sc ch f) (put! g row (+ sc 1) 'wide f))
                        (put! g row sc #\space f))))]
               [else (when (visible? sc) (put! g row sc ch (face)))])
              (loop j (+ col w) ss))])))))

  ;; Decorators mark up a buffer's text beyond its syntax: diagnostics,
  ;; say. (decorator buffer start end) gives the ranges to mark between
  ;; positions start and end, as (start end face) lists -- a face's name,
  ;; or a face -- which are drawn over the syntax's faces and under the
  ;; selections.
  (define decorators '())
  (define (add-decorator! f) (set! decorators (append decorators (list f))))
  (define (remove-decorator! f) (set! decorators (remq f decorators)))

  ;; Decorators of one view, rather than of every view of a buffer: (f v
  ;; start end) gives spans as a decorator's do, for what one client shows
  ;; alone (the link under its pointer, say).
  (define view-decorators '())
  (define (add-view-decorator! f) (set! view-decorators (append view-decorators (list f))))
  (define (remove-view-decorator! f) (set! view-decorators (remq f view-decorators)))

  (define (decoration-spans fs call)
    (apply append
           (map (lambda (f)
                  (map (lambda (d) (list (car d) (cadr d) (let ([f (caddr d)]) (if (face? f) f (F f)))))
                       (guard (e [#t '()]) (call f))))
                fs)))

  (define (decorations b start end)
    (decoration-spans decorators (lambda (f) (f b start end))))

  ;; Major modes that draw their buffers themselves (an image's, say):
  ;; mode name -> (drawer grid view row0 height width), which draws rows
  ;; row0 to row0 + height, with place-picture! if it likes.
  (define buffer-drawers (make-eq-hashtable))
  (define (define-buffer-drawer! mode-name drawer) (hashtable-set! buffer-drawers mode-name drawer))

  ;; Draw view v's buffer; returns the width of its gutter.
  (define (draw-view! g v row0 height width focused?)
    (let ([drawer (hashtable-ref buffer-drawers (major-mode-name (buffer-major-mode (view-buffer v))) #f)])
      (if drawer
          (begin
            ;; No text is under the pointer.
            (view-geometry-set! #f)
            (drawer g v row0 height width)
            0)
          (draw-buffer! g v row0 height width focused?))))

  ;; ---------------------------------------------------------------------------
  ;; Gutters: columns left of a view's text, for line numbers and whatever
  ;; extensions show beside lines (what changed, who changed it). Each has
  ;; a place, smaller ones further left; (width view), its columns there,
  ;; 0 to leave it out; and (cell view line current? width), what to show
  ;; beside line: text (drawn from its left), or (text . face), or #f. The
  ;; faces are drawn over the row's. With none, there is a blank column.

  (define-record-type gutter (fields name place width cell))
  (define gutters '())

  (define (define-gutter! name place width cell)
    (set! gutters (sort (lambda (a b) (< (gutter-place a) (gutter-place b)))
                        (cons (make-gutter name place width cell) (remp (lambda (x) (eq? (gutter-name x) name)) gutters)))))
  (define (remove-gutter! name) (set! gutters (remp (lambda (x) (eq? (gutter-name x) name)) gutters)))
  (define (gutter-names) (map gutter-name gutters))

  ;; The gutters view v shows, each (gutter column width), and their width
  ;; in all.
  (define (view-gutters v)
    (let loop ([gs gutters] [col 0] [acc '()])
      (if (null? gs)
          (values (reverse acc) (max 1 col))
          (let ([w (guard (e [#t 0]) ((gutter-width (car gs)) v))])
            (if (> w 0)
                (loop (cdr gs) (+ col w) (cons (list (car gs) col w) acc))
                (loop (cdr gs) col acc))))))

  (define (draw-gutters! g row v line cur? shown row-face)
    (for-each
     (lambda (x)
       (let* ([gt (car x)] [col (cadr x)] [w (caddr x)]
              [c (guard (e [#t #f]) ((gutter-cell gt) v line cur? w))])
         (when c
           (let ([text (if (pair? c) (car c) c)] [face (if (pair? c) (cdr c) #f)])
             (put-string! g row col text
                          (if face (face-merge row-face (if (face? face) face (F face))) row-face)
                          (+ col w))))))
     shown))

  ;; Line numbers: absolute, or relative to the cursor's line.
  (at-load
   (define-gutter! 'line-numbers 50
     (lambda (v)
       (if (get-var 'line-numbers (view-buffer v))
           (+ 2 (max 3 (string-length (number->string (text-line-count (buffer-text (view-buffer v)))))))
           0))
     (lambda (v line cur? w)
       (let* ([numbers (get-var 'line-numbers (view-buffer v))]
              [str (number->string
                    (if (and (eq? numbers 'relative) (not cur?))
                        (abs (- line (text-line-of (buffer-text (view-buffer v)) (head-position v (view-primary v)))))
                        (+ line 1)))])
         (cons (string-append (make-string (max 0 (- w 1 (string-length str))) #\space) str)
               (if cur? 'ui.linenr.selected 'ui.linenr))))))

  (define (draw-buffer! g v row0 height width focused?)
    (let*-values ([(shown gutter) (view-gutters v)])
     (let* ([b (view-buffer v)]
           [t (buffer-text b)]
           [nlines (text-line-count t)]
           [_ (scroll-into-view! v height width gutter)]
           [top (view-top v)] [left (view-left v)]
           [last (min (- nlines 1) (+ top height -1))]
           [syn (major-mode-syntax (buffer-major-mode b))]
           [spans (if (<= top last) (highlight-region syn t (buffer-hl-cache b) top last) (vector))]
           [primary-line (text-line-of t (head-position v (view-primary v)))]
           [base (F 'ui)]
           [text-face (UI 'ui.text)]
           [cursorline? (get-var 'cursorline b)]
           [match (matching-bracket v)]
           [tw (get-var 'tab-width b)]
           [ws? (get-var 'show-whitespace b)]
           [others (others-views v)]
           ;; What is drawn over the lines shown: decorations, then the
           ;; selections and cursors.
           [overlays (if (> top last)
                         '()
                         (append (view-decorations v top last)
                                 (selection-spans v others (text-line-start t top) (text-line-end t last))))])
      (view-geometry-set! (list row0 gutter height (- width gutter) top left))
      (do ([r 0 (+ r 1)]) ((= r height))
        (let ([line (+ top r)] [row (+ row0 r)])
          (if (>= line nlines)
              (begin
                (fill-row! g row 0 width base)
                (put! g row 0 #\~ (UI 'ui.virtual)))
              (let* ([s (text-line-start t line)] [e (text-line-end t line)]
                     [cur? (= line primary-line)]
                     [row-face (if (and cur? cursorline? focused?)
                                   (face-merge text-face (F 'ui.cursorline))
                                   text-face)])
                (fill-row! g row 0 width row-face)
                (draw-gutters! g row v line cur? shown row-face)
                (let ([end (draw-line! g b row s e gutter width left row-face (vector-ref spans r)
                                       (filter (lambda (o) (and (< (car o) (+ e 1)) (> (cadr o) s))) overlays)
                                       match tw ws?)])
                  (unless (null? others)
                    (draw-peer-names! g row s e (+ end 2) gutter width row-face others)))))))
      (draw-jump-labels! g b row0 top last gutter left width)
      gutter)))

  ;; What decorates view v's lines top to last: the decorators', and the
  ;; view decorators'.
  (define (view-decorations v top last)
    (if (> top last)
        '()
        (let* ([b (view-buffer v)] [t (buffer-text b)]
               [start (text-line-start t top)] [end (+ 1 (text-line-end t last))])
          (append (if (null? decorators) '() (decorations b start end))
                  ;; Regions' faces (buffer.sls).
                  (filter-map (lambda (r)
                                (let ([f (region-get r 'face)])
                                  (and f (list (region-start r) (region-end r) (if (face? f) f (F f))))))
                              (regions-in b start end))
                  (if (null? view-decorators)
                      '()
                      (decoration-spans view-decorators (lambda (f) (f v start end))))))))

  ;; The names of the people (others' views) whose cursors are on the line
  ;; [s, e] drawn in row, from column col on.
  (define (draw-peer-names! g row s e col gutter width row-face others)
    (let loop ([os (filter (lambda (o) (<= s (head-position o (view-primary o)) e)) others)] [col col])
      (when (and (pair? os) (< col width))
        (let ([c (view-client (car os))])
          (loop (cdr os)
                (+ 1 (put-string! g row (max gutter col) (string-append "◂ " (client-user c))
                                  (face-merge row-face (peer-face c 'name)) width)))))))

  ;; Jump labels over the units they name, on lines top to last.
  (define (draw-jump-labels! g b row0 top last gutter left width)
    (let ([t (buffer-text b)])
      (for-each
       (lambda (j)
         (let* ([pos (cadr j)] [line (text-line-of t pos)])
           (when (<= top line last)
             (put-string! g (+ row0 (- line top)) (max gutter (+ gutter (- (display-column b pos) left)))
                          (car j) (UI 'ui.jump-label) width))))
       (jump-labels))))

  ;; ---------------------------------------------------------------------------
  ;; The status line and the bottom row
  ;;
  ;; Status segments are procedures from a view to (text . face-name) or
  ;; #f; users can add their own with define-status-segment!.

  (define the-status-segments
    (list
     (cons 'left
           (lambda (v)
             (cons (case (view-input-mode v)
                     [(insert) " INS "]
                     [else (if (view-extending? v) " EXT " " NOR ")])
                   (case (view-input-mode v)
                     [(insert) 'ui.statusline.insert]
                     [else (if (view-extending? v) 'ui.statusline.extend 'ui.statusline.normal)]))))
     (cons 'left
           (lambda (v)
             (cons (string-append " " (selection-mode-label (selection-mode-of v)) " ")
                   'ui.statusline.selection-mode)))
     (cons 'left
           (lambda (v)
             (define b (view-buffer v))
             (cons (string-append "  " (buffer-display-name b)
                                  (if (buffer-modified? b) " ●" "")
                                  (if (buffer-read-only? b) " [ro]" ""))
                   'ui.statusline)))
     (cons 'right
           (lambda (v)
             (let ([n (length (view-sels v))])
               (and (> n 1) (cons (format "~a sels  " n) 'ui.statusline)))))
     (cons 'right
           (lambda (v)
             ;; Who else is here.
             (let ([names (map (lambda (o) (client-user (view-client o))) (others-views v))])
               (and (pair? names)
                    (cons (format "with ~a  " (if (> (length names) 3)
                                                  (format "~a and ~a more" (string-join (take names 2) ", ") (- (length names) 2))
                                                  (string-join names ", ")))
                          'ui.statusline.dim)))))
     (cons 'right
           (lambda (v)
             (cons (format "~a  " (major-mode-name (buffer-major-mode (view-buffer v)))) 'ui.statusline.dim)))
     (cons 'right
           (lambda (v)
             (let* ([t (buffer-text (view-buffer v))] [p (view-primary v)]
                    [head (sel-range-start p)] [line (text-line-of t head)])
               (cons (format "~a:~a " (+ line 1) (+ 1 (- head (text-line-start t line))))
                     'ui.statusline))))))

  (define (status-segments) the-status-segments)
  (define (define-status-segment! side proc)
    (set! the-status-segments (append the-status-segments (list (cons side proc)))))

  ;; A pane's status line: an unfocused pane's (not active?) in
  ;; ui.statusline.inactive.
  (define (draw-status! g row v width active?)
    (let ([base (UI (if active? 'ui.statusline 'ui.statusline.inactive))])
      (fill-row! g row 0 width base)
      (let* ([segs (filter-map (lambda (s) (let ([x ((cdr s) v)]) (and x (cons (car s) x)))) the-status-segments)]
             [lefts (filter (lambda (s) (eq? (car s) 'left)) segs)]
             [rights (filter (lambda (s) (eq? (car s) 'right)) segs)]
             [right-width (apply + (map (lambda (s) (string-width (cadr s))) rights))])
        (let loop ([l lefts] [col 0])
          (unless (null? l)
            (loop (cdr l) (put-string! g row col (cadr (car l)) (UI (cddr (car l))) (- width right-width)))))
        (let loop ([l rights] [col (- width right-width)])
          (unless (null? l)
            (loop (cdr l) (put-string! g row (max 0 col) (cadr (car l)) (UI (cddr (car l))))))))))

  (define (draw-bufferline! g b width)
    (let ([base (UI 'ui.statusline.inactive)])
      (fill-row! g 0 0 width base)
      (let loop ([bs (buffers)] [col 0])
        (unless (or (null? bs) (>= col width))
          (let* ([x (car bs)]
                 [label (string-append " " (buffer-name x) (if (buffer-modified? x) " ●" "") " ")]
                 [face (if (eq? x b) (UI 'ui.statusline.normal) base)])
            (loop (cdr bs) (+ 1 (put-string! g 0 col label face))))))))

  ;; The bottom row: the prompt when one is open, else the message.
  (define (draw-bottom! g row width)
    (fill-row! g row 0 width (UI 'ui.prompt))
    (let ([m (current-message)])
      (when m
        (put-string! g row 0 (string-first-line (cdr m)) (UI (car m))))))

  ;; ---------------------------------------------------------------------------
  ;; Overlays: the editor's own, from widgets (widget.sls)
  ;;
  ;; What a client shows over its panes follows from its state: its popup,
  ;; its prompt (a picker, a dialog, a menu at the cursor, a line in the
  ;; bottom row with completions above it), the legend of the active
  ;; layer's keys. Each is an overlay (prompt.sls), made afresh each frame;
  ;; extensions' overlays go between the popup and the prompt.

  (define (now x) (if (procedure? x) (x) x))

  ;; A popup: at the right between the panes' top and bottom, its last
  ;; lines if it has more than fit.
  (define (popup-overlay pop)
    (let ([w (framed (lambda () (now (popup-title pop)))
                     (text-lines (lambda () ((popup-lines-of pop))) #t)
                     (list (cons 'footer (lambda () (let ([f (now (popup-footer pop))]) (and f (string-append " " f " ")))))))])
      (make-overlay
       'popup
       (lambda (a)
         (let* ([cols (area-cols a)]
                [width (min (- cols 2) (max 50 (quotient cols 2)) 100)]
                [height (min (- (area-bottom a) (area-top a)) (max 3 (widget-rows w width)))])
           (and (>= height 3) (> width 4)
                (list (area-top a) (- cols width 1) height width))))
       w
       #f)))

  (define (popup-lines-of pop)
    (lambda ()
      (map (lambda (l) (cons (car l) (face-merge (UI 'ui.popup) (F (cdr l))))) ((popup-lines pop)))))

  ;; A picker: a centered window with the query and the filtered
  ;; candidates. Its hint, if any, wraps above the query. It is as tall as
  ;; its most candidates need, so a few choices make a small window, which
  ;; keeps its size as the query filters them.
  (define (picker-overlay p)
    (let* ([geometry
            (lambda (rows cols)
              (let* ([width (min (- cols 4) 100)]
                     [most-height (min (- rows 4) 24)]
                     [hint (if (prompt-hint p) (wrap-text (prompt-hint p) (- width 4)) '())]
                     [hint (if (> (length hint) (quotient most-height 3))
                               (append (take hint (- (quotient most-height 3) 1)) (list "…"))
                               hint)]
                     [skip (if (null? hint) 0 (+ (length hint) 1))]
                     [height (min most-height (+ 4 skip (max 1 (prompt-most p))))])
                (values width height hint)))]
           [hint-lines '()])
      (make-overlay
       'picker
       (lambda (a)
         (let-values ([(width height hint) (geometry (area-rows a) (area-cols a))])
           (set! hint-lines hint)
           (list (quotient (- (area-rows a) height) 2) (quotient (- (area-cols a) width) 2) height width)))
       (framed (prompt-label p)
            (make-widget
             (lambda (cols) 0)
             (lambda (g row col rows cols)
               (let* ([face (UI 'ui.popup)] [hint (map (lambda (l) (cons l face)) hint-lines)])
                 (widget-draw!
                  (apply stack
                         (append
                          (if (null? hint) '() (list (cons (length hint) (text-lines hint)) (cons 1 (rule))))
                          (list (cons 1 (input-line "❯ " (UI 'ui.prompt.label) (prompt-input p) (prompt-cursor p) face))
                                (cons 1 (rule))
                                (cons #f (item-list (prompt-items p) (prompt-index p) '((scroll . center)))))))
                  g row col rows cols))))
            (list (cons 'right (lambda ()
                                 (let ([n (length (prompt-items p))])
                                   (format " ~a/~a " (if (= n 0) 0 (+ (prompt-index p) 1)) n))))))
       #f)))

  ;; A dialog: a centered window, the input wrapping inside it, a little
  ;; above the middle as a form's would be. The box grows with the text up
  ;; to half the screen, then scrolls to keep the cursor in view.
  (define (dialog-overlay p)
    (let* ([face (UI 'ui.popup)]
           [input (lambda () (if (eq? (prompt-style p) 'secret)
                                 (make-string (string-length (prompt-input p)) #\x2022)
                                 (prompt-input p)))]
           [area-of (lambda (rows)
                      (text-area input (lambda () (prompt-cursor p)) face (prompt-hint p)
                                 (face-merge face (F 'ui.popup.info)) 3 (max 1 (- (quotient rows 2) 2))))]
           [inside #f])
      (make-overlay
       'dialog
       (lambda (a)
         (let* ([rows (area-rows a)] [cols (area-cols a)]
                [width (min (- cols 4) 80)]
                [t (area-of rows)]
                [height (+ 2 (widget-rows t (- width 2)))])
           (set! inside t)
           (list (max 0 (- (quotient (- rows height) 2) (quotient rows 8))) (quotient (- cols width) 2) height width)))
       (framed (prompt-label p)
            (make-widget (lambda (cols) 0) (lambda (g row col rows cols) (widget-draw! inside g row col rows cols)))
            '((footer . " ⏎ send · esc cancel ")))
       #f)))

  ;; A menu: a prompt's candidates in a small window at the primary cursor,
  ;; below it where there is room, as completions are shown. What is typed
  ;; goes into the text (the prompt's on-change puts it there), so the
  ;; cursor stays in the text.
  (define (menu-overlay p)
    (make-overlay
     'menu
     (lambda (a)
       (let ([cursor (area-cursor a)])
         (and cursor
              (let* ([r (car cursor)] [c (cadr cursor)] [top (area-top a)] [bottom (area-bottom a)]
                     [items (prompt-items p)] [n (length items)]
                     [shown (max 1 (min 10 n (- bottom top 2)))]
                     [widest (apply max 0 (map (lambda (i) (string-width (car (car i)))) (take items (min n 100))))]
                     [width (max 16 (min (- (area-cols a) 2) 60 (+ widest 4)))]
                     [height (+ shown 2)])
                (list (if (<= (+ r 1 height) bottom) (+ r 1) (max top (- r height)))
                      (max 0 (min (- c 2) (- (area-cols a) width)))
                      height width)))))
     (framed (prompt-label p)
          (item-list (lambda () (prompt-items p)) (lambda () (prompt-index p)) '((scroll . follow) (empty . "no matches")))
          (list (cons 'footer (lambda ()
                                (let ([n (length (prompt-items p))])
                                  (and (> n 1) (format " ~a/~a " (+ (prompt-index p) 1) n)))))))
     #f))

  ;; A line prompt: its label and input in the bottom row, its candidates
  ;; listed above the panes' bottom.
  (define (line-overlays p)
    (list
     (make-overlay
      'completions
      (lambda (a)
        (let ([n (min 10 (length (prompt-items p)))])
          (and (> n 0) (list (- (area-bottom a) n) 0 n (area-cols a)))))
      (item-list (lambda () (prompt-items p)) (lambda () (prompt-index p)) '((scroll . follow) (style . plain)))
      #f)
     (make-overlay
      'prompt
      (lambda (a) (list (- (area-rows a) 1) 0 1 (area-cols a)))
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (fill-row! g row col (+ col cols) (UI 'ui.prompt))
         (let ([c (put-string! g row col (prompt-label p) (UI 'ui.prompt.label))])
           (put-string! g row (+ c 1) (prompt-input p) (UI 'ui.prompt))
           (list row (+ col (string-width (prompt-label p)) 1
                        (string-width (substring (prompt-input p) 0 (prompt-cursor p))))
                 'bar))))
      #f)))

  ;; The keys of the active layer, which-key style, in the bottom right.
  (define (legend-overlay)
    (let* ([km (active-layer-keymap)]
           [entries (keymap-entries km)]
           [entries (if (keymap-on-tap km)
                        (cons (cons (let ([l (active-layer)]) (vector-ref l 1))
                                    (let ([c (keymap-on-tap km)])
                                      (list 'tap (if (symbol? c) (symbol->string c) "tap"))))
                              entries)
                        entries)]
           [cells (map (lambda (e)
                         (cons (pretty-key (car e))
                               (if (and (pair? (cdr e)) (eq? (cadr e) 'tap))
                                   (string-append "tap: " (caddr e))
                                   (binding-label (cdr e)))))
                       entries)]
           [key-w (apply max 1 (map (lambda (c) (string-width (car c))) cells))]
           [label-w (apply max 1 (map (lambda (c) (string-width (cdr c))) cells))]
           [col-w (min 30 (+ key-w label-w 3))]
           [nrows-of (lambda (cols)
                       (let* ([max-cols (max 1 (quotient (- (min cols 120) 4) col-w))]
                              [ncols (min max-cols (max 1 (quotient (+ (length cells) 7) 8)))])
                         (values ncols (quotient (+ (length cells) ncols -1) ncols))))]
           [nrows 1])
      (make-overlay
       'legend
       (lambda (a)
         (let-values ([(ncols rows) (nrows-of (area-cols a))])
           (set! nrows rows)
           (let ([height (min (- (area-bottom a) 1) (+ rows 2))] [width (+ 4 (* ncols col-w))])
             (and (> height 2)
                  (list (- (area-bottom a) height) (max 0 (- (area-cols a) width 1)) height width)))))
       (framed (keymap-title km)
            (make-widget (lambda (cols) nrows)
                         (lambda (g row col rows cols)
                           (widget-draw! (key-grid cells nrows col-w (UI 'ui.popup.key) (UI 'ui.popup.info))
                                         g row col rows cols))))
       #f)))

  ;; What client c shows over its panes, from the bottom up.
  (define (editor-overlays c)
    (let ([p (current-prompt)])
      (append
       (if (current-popup) (list (popup-overlay (current-popup))) '())
       (client-overlays c)
       (cond
        [(not p) '()]
        [(eq? (prompt-style p) 'picker) (list (picker-overlay p))]
        [(memq (prompt-style p) '(dialog secret)) (list (dialog-overlay p))]
        [(eq? (prompt-style p) 'menu) (list (menu-overlay p))]
        [(eq? (prompt-style p) 'line) (line-overlays p)]
        [else '()])
       (if (and (layer-legend-visible?) (not p)) (list (legend-overlay)) '()))))

  ;; Draw overlays in g, bottom first, each where it places itself in area
  ;; a: the cursor of the last that has one, or #f.
  (define (draw-overlays! g a overlays)
    (fold-left (lambda (cursor o)
                 (let ([rect (guard (e [#t #f]) ((overlay-place o) a))])
                   (or (and rect
                            (widget-draw! (overlay-widget o) g (car rect) (cadr rect) (caddr rect) (cadddr rect)))
                       cursor)))
               #f overlays))

  ;; ---------------------------------------------------------------------------
  ;; Frames

  ;; Draw pane p of client c, focused there, in rows row.. and columns
  ;; col.. of g: its view, then its status line. A pane as wide as g is
  ;; drawn in it; another into a grid of its own, copied in, its geometry
  ;; (the mouse's, the cursor's) moved to where it is.
  (define (draw-pane! c g p row col rows cols focused?)
    (pane-rect-set! p (list row col rows cols))
    (let ([v (client-view c)] [comp (pane-component p)])
      (if comp
          (draw-component! c g p comp row col rows cols focused?)
          (draw-view-pane! c g p v row col rows cols focused?))))

  ;; A component's pane: drawn on a canvas, a grid the pane's size; where
  ;; its cursor is, if it is focused, is kept for the frame.
  (define (draw-component! c g p comp row col rows cols focused?)
    (let* ([canvas (new-grid rows cols (UI 'ui.text))]
           [cursor (guard (e [#t (put-string! canvas 0 0 (condition->string e) (UI 'error)) #f])
                     ((component-draw comp) canvas focused?))])
      (blit! g canvas row col)
      ;; No text is under the pointer.
      (view-geometry-set! #f)
      (when (eq? p (client-focused-pane c))
        (client-local-set! c 'component-cursor
                           (and cursor (list (+ row (car cursor)) (+ col (cadr cursor)) (caddr cursor)))))))

  (define (draw-view-pane! c g p v row col rows cols focused?)
    (when v
      (if (and (= col 0) (= cols (grid-cols g)))
          (begin
            (draw-view! g v row (- rows 1) cols focused?)
            (draw-status! g (+ row rows -1) v cols (eq? p (client-focused-pane c))))
          (let ([sub (new-grid rows cols (F 'ui))])
            (draw-view! sub v 0 (- rows 1) cols focused?)
            (draw-status! sub (- rows 1) v cols (eq? p (client-focused-pane c)))
            (blit! g sub row col)
            (let ([geo (view-geometry)])
              (when geo
                (view-geometry-set! (cons* (+ row (car geo)) (+ col (cadr geo)) (cddr geo)))))))))

  ;; Draw client c's layout in rows row.. and columns col.. of g. Each pane
  ;; is drawn with it focused, so that what draws a view draws its; the
  ;; focus is the focused pane's again after. Panes side by side have a
  ;; line between them; one above another, its status line.
  (define (draw-layout! c g row col rows cols focusable?)
    (let ([focused (client-focused-pane c)] [line (UI 'ui.window)])
      (let walk ([n (client-layout c)] [r row] [k col] [h rows] [w cols])
        (cond
         [(split? n)
          (if (eq? (split-dir n) 'right)
              (let ([w1 (max 1 (min (- w 2) (exact (floor (* (- w 1) (split-ratio n))))))])
                (walk (split-first n) r k h w1)
                (do ([i 0 (+ i 1)]) ((= i h)) (put! g (+ r i) (+ k w1) #\x2502 line))
                (walk (split-second n) r (+ k w1 1) h (- w w1 1)))
              (let ([h1 (max 1 (min (- h 1) (exact (floor (* h (split-ratio n))))))])
                (walk (split-first n) r k h1 w)
                (walk (split-second n) (+ r h1) k (- h h1) w)))]
         ;; Too small to show anything: not drawn, nor found by the mouse.
         [(or (< h 2) (< w 4)) (pane-rect-set! n #f)]
         [else
          (focus-pane! c n)
          (draw-pane! c g n r k h w (and focusable? (eq? n focused)))]))
      (focus-pane! c focused)))

  ;; Draw client c's frame and send it what changed. The client's own
  ;; state (prompt, layer, message, view) is current while drawing.
  ;; Where position pos of view v (of buffer b) shows, in the text area
  ;; at geo (row col rows cols top left): (row col), or #f off it.
  (define (screen-cell geo v b pos)
    (let ([r (+ (car geo) (- (text-line-of (buffer-text b) pos) (view-top v)))]
          [col (+ (cadr geo) (- (display-column b pos) (view-left v)))])
      (and (<= (car geo) r (+ (car geo) (caddr geo) -1))
           (<= (cadr geo) col (+ (cadr geo) (cadddr geo) -1))
           (list r col))))

  (define (render-client! c)
    (with-client c
      (lambda ()
        (run-hooks 'before-render-hook c)
        (let ([v (client-view c)])
          (when v
            (let* ([rows (max 3 (client-rows c))] [cols (max 10 (client-cols c))]
                   [g (new-grid rows cols (F 'ui))]
                   [b (view-buffer v)]
                   [tabs? (> (length (buffers)) 1)]
                   [text-top (if tabs? 1 0)]
                   [status-row (- rows 2)]
                   [p (current-prompt)]
                   [single? (not (split? (client-layout c)))])
              (when tabs? (draw-bufferline! g b cols))
              (draw-layout! c g text-top 0 (- rows 1 text-top) cols (not p))
              (let* ([v (client-view c)] [b (view-buffer v)]
                     ;; Where the focused pane's text is: (row col rows cols top left).
                     [geo (view-geometry)]
                     ;; The cursor in its text, where a menu goes: (row col), or #f.
                     [at-head (and geo (not (focused-component c))
                                   (screen-cell geo v b (head-position v (view-primary v))))]
                     [_ (draw-bottom! g (- rows 1) cols)]
                     [over (draw-overlays! g (make-area rows cols text-top status-row at-head) (editor-overlays c))]
                     [cursor
                      (cond
                       [(and p (memq (prompt-style p) '(picker dialog secret line))) over]
                       [(and p (eq? (prompt-style p) 'menu)) (and at-head (list (car at-head) (cadr at-head) 'bar))]
                       [(key-overlay c) over]
                       [(focused-component c) (client-local c 'component-cursor #f)]
                       ;; In insert mode a bar between characters;
                       ;; else the selection's head, which its face
                       ;; shows, so drawn by no one: for screen readers.
                       [(not geo) #f]
                       [else
                        (let* ([insert? (eq? (view-input-mode v) 'insert)]
                               [at (screen-cell geo v b (if insert?
                                                            (sel-start (view-primary v))
                                                            (head-position v (view-primary v))))])
                          (and at (append at (list (if insert? 'bar 'hidden)))))])])
                (draw-effects! c g)
                ;; A scroll is a whole row's: with panes side by side, none.
                (send-frame! c g cursor (and single? (list text-top status-row b (view-top v))))))))))))
