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
          face-id add-decorator! remove-decorator! define-buffer-drawer!
          make-picture picture? picture-key picture-width picture-height picture-png
          place-picture! put-string! ui-face)
  (import (chezscheme) (quad util) (quad text) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor))

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
  (define-record-type frame (fields grid known cursor scroll images))

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
      (make-grid (grid-rows prev) cols chars faces '())))

  ;; Forget what client c shows, so the next frame redraws it whole.
  (define (invalidate-client! c) (client-frame-set! c #f))

  (define (cell-text ch) (cond [(char? ch) (string ch)] [(string? ch) ch] [else ""]))

  ;; The cells of row r from c0 to c1, as Neovim's grid_line has them:
  ;; (text hl repeat), with repeat left out when it is 1, and hl too when it
  ;; is the previous cell's.
  (define (row-cells g r c0 c1 hl!)
    (let ([chars (vector-ref (grid-chars g) r)] [faces (vector-ref (grid-faces g) r)])
      ;; Runs of identical cells first, as (text hl count).
      (let loop ([c c0] [acc '()])
        (if (< c c1)
            (let ([text (cell-text (vector-ref chars c))] [hl (hl! (vector-ref faces c))])
              (if (and (pair? acc) (string=? text (car (car acc))) (= hl (cadr (car acc))))
                  (loop (+ c 1) (cons (list text hl (+ 1 (caddr (car acc)))) (cdr acc)))
                  (loop (+ c 1) (cons (list text hl 1) acc))))
            (let compact ([runs (reverse acc)] [last-hl #f] [out '()])
              (if (null? runs)
                  (reverse out)
                  (let* ([run (car runs)] [text (car run)] [hl (cadr run)] [n (caddr run)])
                    (compact (cdr runs) hl
                             (cons (cond [(> n 1) (list text hl n)]
                                         [(eqv? hl last-hl) (list text)]
                                         [else (list text hl)])
                                   out)))))))))

  ;; scroll is the text area, as frame-scroll has it: when it shows the
  ;; same buffer as before, moved by fewer lines than it has, a client
  ;; that can ("scroll") is told to move its rows, and is sent only what
  ;; that leaves different.
  (define (send-frame! c g cursor scroll)
    (let* ([cursor (and cursor (or (not (eq? (caddr cursor) 'hidden)) (client-has? c "hidden-cursor"))
                        cursor)]
           [old (client-frame c)]
           [full? (or (not old)
                      (not (= (grid-rows (frame-grid old)) (grid-rows g)))
                      (not (= (grid-cols (frame-grid old)) (grid-cols g))))]
           [known (if full? (make-eqv-hashtable) (frame-known old))]
           [shift (and (not full?) scroll (frame-scroll old) (client-has? c "scroll")
                       (let ([was (frame-scroll old)])
                         (and (= (car scroll) (car was)) (= (cadr scroll) (cadr was))
                              (eq? (caddr scroll) (caddr was))
                              (let ([n (- (cadddr scroll) (cadddr was))])
                                (and (not (zero? n)) (< (abs n) (- (cadr scroll) (car scroll))) n)))))]
           [prev (and (not full?)
                      (if shift
                          (scrolled-grid (frame-grid old) (car scroll) (cadr scroll) shift)
                          (frame-grid old)))]
           [changed? full?]
           [pictures (if (client-has? c "images") (frame-pictures g) '())]
           [hl! (lambda (f)
                  (let ([id (face-id f)])
                    (unless (hashtable-contains? known id)
                      (hashtable-set! known id #t)
                      (client-send! c (list "hl" id (face-fg f) (face-bg f) (face-flags f)
                                            (face-underline-color f) (face-link f))))
                    id))])
      (when full? (client-send! c (list "grid" (grid-rows g) (grid-cols g))))
      (when shift
        (set! changed? #t)
        (client-send! c (list "scroll" (car scroll) (cadr scroll) shift)))
      (do ([r 0 (+ r 1)]) ((= r (grid-rows g)))
        (let ([chars (vector-ref (grid-chars g) r)] [faces (vector-ref (grid-faces g) r)])
          (let-values ([(first last)
                        (if full?
                            (values 0 (- (grid-cols g) 1))
                            (let ([pchars (vector-ref (grid-chars prev) r)] [pfaces (vector-ref (grid-faces prev) r)])
                              (let loop ([i 0] [first #f] [last #f])
                                (if (= i (grid-cols g))
                                    (values first last)
                                    (if (and (equal? (vector-ref chars i) (vector-ref pchars i))
                                             (eq? (vector-ref faces i) (vector-ref pfaces i)))
                                        (loop (+ i 1) first last)
                                        (loop (+ i 1) (or first i) i))))))])
            (when first
              ;; Never start on the right half of a wide character.
              (let ([first (if (and (> first 0) (eq? (vector-ref chars first) 'wide)) (- first 1) first)])
                (set! changed? #t)
                (client-send! c (list "line" r first (row-cells g r first (+ last 1) hl!))))))))
      ;; Pictures, each sent once to a client (which keeps them), then
      ;; where they are, when that changes (a terminal forgets on "grid").
      (when (and (client-has? c "images") (or full? (not (equal? (map car pictures) (frame-images old)))))
        (let ([sent (or (client-local c 'pictures #f)
                        (let ([h (make-hashtable string-hash string=?)]) (client-local-set! c 'pictures h) h))])
          (for-each (lambda (p)
                      (let ([pic (cdr p)])
                        (unless (hashtable-contains? sent (picture-key pic))
                          (hashtable-set! sent (picture-key pic) #t)
                          (client-send! c (list "image" (picture-key pic) (picture-width pic)
                                                (picture-height pic) (picture-png pic))))))
                    pictures))
        (set! changed? #t)
        (client-send! c (list "images" (map car pictures))))
      ;; A frame like the last is not sent: clients draw only what changed.
      (when (or changed? (not (equal? cursor (frame-cursor old))))
        (client-send! c (if cursor (list "cursor" (car cursor) (cadr cursor) (symbol->string (caddr cursor)))
                            '("cursor" #f)))
        (client-send! c '("flush")))
      (client-frame-set! c (make-frame g known cursor scroll (map car pictures)))))

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

  ;; Overlay faces per position on a line: selections and cursors, under
  ;; the other people's selections and cursors in the same buffer, each in
  ;; their color.
  (define (selection-spans v line-start line-end)
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
                              (others-views v)))])
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
  ;; `left`, starting at screen column `gutter`.
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
           [(> i e) (void)]
           [(= i e)
            ;; The newline: a space, so a selection or a cursor on it shows.
            (when (visible? sc) (put! g row sc #\space (face-for i ss)))]
           [else
            ;; A grapheme cluster: a character and what extends it.
            (let* ([ch (text-ref t i)]
                   [tab? (char=? ch #\tab)]
                   [j (if tab? (+ i 1) (grapheme-end ref i e))]
                   [w (if tab? (- tw (modulo col tw)) (grapheme-columns ref i j))]
                   [ch (if (= j (+ i 1)) ch (text-substring t i j))]
                   [face (face-for i ss)])
              (cond
               [(= w 0)
                ;; Marks with nothing to mark (after a tab, at the line's
                ;; start) join the cell before them.
                (let ([pc (- sc 1)])
                  (when (visible? pc)
                    (let ([prev (vector-ref (vector-ref (grid-chars g) row) pc)])
                      (put! g row pc
                            (string-append (cond [(char? prev) (string prev)] [(string? prev) prev] [else ""])
                                           (if (char? ch) (string ch) ch))
                            (face-at g row pc)))))]
               [tab?
                (do ([k 0 (+ k 1)]) ((= k w))
                  (when (visible? (+ sc k))
                    (put! g row (+ sc k) (if (and ws? (= k 0)) #\→ #\space)
                          (if ws? (face-merge face (F 'ui.virtual.whitespace)) face))))]
               [(= w 2)
                (when (visible? sc)
                  (if (visible? (+ sc 1))
                      (begin (put! g row sc ch face) (put! g row (+ sc 1) 'wide face))
                      (put! g row sc #\space face)))]
               [else (when (visible? sc) (put! g row sc ch face))])
              (loop j (+ col w) ss))])))))

  ;; Decorators mark up a buffer's text beyond its syntax: diagnostics,
  ;; say. (decorator buffer start end) gives the ranges to mark between
  ;; positions start and end, as (start end face) lists -- a face's name,
  ;; or a face -- which are drawn over the syntax's faces and under the
  ;; selections.
  (define decorators '())
  (define (add-decorator! f) (set! decorators (append decorators (list f))))
  (define (remove-decorator! f) (set! decorators (remq f decorators)))

  (define (decorations b start end)
    (apply append
           (map (lambda (f)
                  (map (lambda (d) (list (car d) (cadr d) (let ([f (caddr d)]) (if (face? f) f (F f)))))
                       (guard (e [#t '()]) (f b start end))))
                decorators)))

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

  (define (draw-buffer! g v row0 height width focused?)
    (let* ([b (view-buffer v)]
           [t (buffer-text b)]
           [nlines (text-line-count t)]
           [numbers (get-var 'line-numbers b)]
           [gutter (if numbers (+ 2 (max 3 (string-length (number->string nlines)))) 1)]
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
           [jumps (jump-labels)]
           [others (others-views v)]
           [decos (if (or (null? decorators) (> top last))
                      '()
                      (decorations b (text-line-start t top) (+ 1 (text-line-end t last))))]
           ;; The link under the pointer (see link.sls), underlined.
           [decos (let ([h (let ([c (view-client v)]) (and c (client-local c 'hover-link #f)))])
                    (if (and h (eq? (car h) b))
                        (append decos (list (list (cadr h) (caddr h) (F 'ui.link.hover))))
                        decos))])
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
                (when numbers
                  (let* ([n (if (and (eq? numbers 'relative) (not cur?)) (abs (- line primary-line)) (+ line 1))]
                         [str (number->string n)])
                    (put-string! g row (- gutter 1 (string-length str)) str
                                 (face-merge row-face (F (if cur? 'ui.linenr.selected 'ui.linenr))))))
                (draw-line! g b row s e gutter width left row-face (vector-ref spans r)
                            (append (filter (lambda (d) (and (< (car d) (+ e 1)) (> (cadr d) s))) decos)
                                    (selection-spans v s e))
                            match tw ws?)
                ;; Who else has their cursor on this line, after its end.
                (let ([here (filter (lambda (o) (<= s (head-position o (view-primary o)) e)) others)])
                  (unless (null? here)
                    (let loop ([os here] [col (+ gutter (- (display-column b e) left) 2)])
                      (when (and (pair? os) (< col width))
                        (let ([c (view-client (car os))])
                          (loop (cdr os)
                                (+ 1 (put-string! g row (max gutter col) (string-append "◂ " (client-user c))
                                                  (face-merge row-face (peer-face c 'name)) width))))))))))))
      ;; Jump labels over the units they name.
      (for-each
       (lambda (j)
         (let ([pos (car (cdr j))])
           (when (<= top (text-line-of t pos) last)
             (let ([row (+ row0 (- (text-line-of t pos) top))]
                   [col (+ gutter (- (display-column b pos) left))])
               (put-string! g row (max gutter col) (car j) (UI 'ui.jump-label) width)))))
       jumps)
      gutter))

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

  (define (draw-status! g row v width)
    (let ([base (UI 'ui.statusline)])
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
    (let ([p (current-prompt)])
      (fill-row! g row 0 width (UI 'ui.prompt))
      (cond
       [(and p (eq? (prompt-style p) 'line))
        (let* ([col (put-string! g row 0 (prompt-label p) (UI 'ui.prompt.label))]
               [col (put-string! g row (+ col 1) (prompt-input p) (UI 'ui.prompt))])
          (list row (+ (string-width (prompt-label p)) 1
                       (string-width (substring (prompt-input p) 0 (prompt-cursor p))))
                'bar))]
       [(current-message)
        => (lambda (m)
             (let ([text (car (reverse (cons "" (string-split (cdr m) #\newline))))])
               (put-string! g row 0 (let ([lines (string-split (cdr m) #\newline)]) (car lines))
                            (UI (car m)))
               #f))]
       [else #f])))

  ;; ---------------------------------------------------------------------------
  ;; Popups

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

  ;; The keys of the active layer, which-key style, in the bottom right.
  (define (draw-legend! g rows cols bottom)
    (let* ([km (active-layer-keymap)]
           [entries (keymap-entries km)]
           [entries (if (keymap-on-tap km)
                        (cons (cons (let ([l (active-layer)]) (vector-ref l 1))
                                    (let ([c (keymap-on-tap km)])
                                      (list 'tap (if (symbol? c) (symbol->string c) "tap"))))
                              entries)
                        entries)]
           [cell (lambda (e)
                   (let ([k (car e)]
                         [label (if (and (pair? (cdr e)) (eq? (cadr e) 'tap))
                                    (string-append "tap: " (caddr e))
                                    (binding-label (cdr e)))])
                     (cons (pretty-key k) label)))]
           [cells (map cell entries)]
           [key-w (apply max 1 (map (lambda (c) (string-width (car c))) cells))]
           [label-w (apply max 1 (map (lambda (c) (string-width (cdr c))) cells))]
           [col-w (min 30 (+ key-w label-w 3))]
           [max-cols (max 1 (quotient (- (min cols 120) 4) col-w))]
           [ncols (min max-cols (max 1 (quotient (+ (length cells) 7) 8)))]
           [nrows (quotient (+ (length cells) ncols -1) ncols)]
           [height (min (- bottom 1) (+ nrows 2))]
           [width (+ 4 (* ncols col-w))]
           [top (- bottom height)]
           [left (max 0 (- cols width 1))])
      (when (> height 2)
        (draw-box! g top left height width (keymap-title km))
        (let loop ([cs cells] [i 0])
          (unless (null? cs)
            (let* ([r (+ top 1 (remainder i nrows))] [c (+ left 2 (* col-w (quotient i nrows)))])
              (when (< r (+ top height -1))
                (put-string! g r (+ c (- key-w (string-width (car (car cs))))) (car (car cs)) (UI 'ui.popup.key))
                (put-string! g r (+ c key-w 2) (cdr (car cs)) (UI 'ui.popup.info) (+ c col-w))))
            (loop (cdr cs) (+ i 1)))))))

  (define (pretty-key k)
    (cond [(string=? k "space") "␣"]
          [(string=? k "enter") "⏎"]
          [(string=? k "backspace") "⌫"]
          [(string=? k "tab") "⇥"]
          [(string=? k "esc") "⎋"]
          [else k]))

  ;; A picker: a centered window with the query and the filtered candidates.
  ;; Its hint, if any, wraps above the query. It is as tall as its most
  ;; candidates need, so a few choices make a small window, which keeps its
  ;; size as the query filters them.
  (define (draw-picker! g rows cols p)
    (let* ([width (min (- cols 4) 100)]
           [most-height (min (- rows 4) 24)]
           [hint (if (prompt-hint p) (wrap-text (prompt-hint p) (- width 4)) '())]
           [hint (if (> (length hint) (quotient most-height 3))
                     (append (take hint (- (quotient most-height 3) 1)) (list "…"))
                     hint)]
           [skip (if (null? hint) 0 (+ (length hint) 1))]
           [height (min most-height (+ 4 skip (max 1 (prompt-most p))))]
           [top (quotient (- rows height) 2)]
           [left (quotient (- cols width) 2)]
           [query (+ top 1 skip)]
           [items (prompt-items p)]
           [n (length items)]
           [visible (max 0 (- height 4 skip))]
           [index (prompt-index p)]
           [first (max 0 (min (- index (quotient visible 2)) (- n visible)))]
           [rule (lambda (r) (do ([c 1 (+ c 1)]) ((>= c (- width 1))) (put! g r (+ left c) #\─ (UI 'ui.popup.border))))])
      (draw-box! g top left height width (prompt-label p))
      (let ([count (format " ~a/~a " (if (= n 0) 0 (+ index 1)) n)])
        (put-string! g top (- (+ left width) 2 (string-length count)) count (UI 'ui.popup.border)))
      (let loop ([ls hint] [r (+ top 1)])
        (unless (null? ls)
          (put-string! g r (+ left 2) (car ls) (UI 'ui.popup) (+ left width -2))
          (loop (cdr ls) (+ r 1))))
      (when (pair? hint) (rule (- query 1)))
      (let ([col (put-string! g query (+ left 2) "❯ " (UI 'ui.prompt.label))])
        (put-string! g query col (prompt-input p) (UI 'ui.popup) (+ left width -2))
        (rule (+ query 1))
        (let loop ([items (drop items first)] [i first] [r (+ query 2)])
          (when (and (pair? items) (< r (+ top height -1)))
            (draw-candidate! g r left width (car items) (= i index))
            (loop (cdr items) (+ i 1) (+ r 1))))
        (list query (+ col (string-width (substring (prompt-input p) 0 (prompt-cursor p)))) 'bar))))

  ;; A prompt's candidate, as a row of a window from column left, width
  ;; wide: its text, with the characters the query matched marked.
  (define (draw-candidate! g r left width item selected?)
    (let ([face (UI (if selected? 'ui.menu.selected 'ui.menu))] [hits (cdr item)] [text (car (car item))])
      (fill-row! g r (+ left 1) (+ left width -1) face)
      (let ([ref (lambda (i) (string-ref text i))] [n (string-length text)])
        (let chars ([j 0] [c (+ left 2)])
          (when (and (< j n) (< c (+ left width -2)))
            (let* ([k (grapheme-end ref j n)]
                   [hit? (exists (lambda (h) (<= j h (- k 1))) hits)])
              (put! g r c (if (= k (+ j 1)) (string-ref text j) (substring text j k))
                    (if hit? (face-merge face (F 'ui.menu.match)) face))
              (chars k (+ c (max 1 (grapheme-columns ref j k))))))))))

  ;; A menu: a prompt's candidates in a small window at the primary cursor,
  ;; below it where there is room, as completions are shown. What is typed
  ;; goes into the text (the prompt's on-change puts it there), so the
  ;; cursor stays in the text. Rows top to bottom are the text's.
  (define (draw-menu! g cols p v gutter text-top bottom)
    (let* ([b (view-buffer v)] [t (buffer-text b)]
           [pos (head-position v (view-primary v))]
           [r (+ text-top (- (text-line-of t pos) (view-top v)))]
           [c (+ gutter (- (display-column b pos) (view-left v)))]
           [items (prompt-items p)] [n (length items)] [index (prompt-index p)]
           [shown (max 1 (min 10 n (- bottom text-top 2)))]
           [widest (apply max 0 (map (lambda (i) (string-width (car (car i)))) (take items (min n 100))))]
           [width (max 16 (min (- cols 2) 60 (+ widest 4)))]
           [height (+ shown 2)]
           [top (if (<= (+ r 1 height) bottom) (+ r 1) (max text-top (- r height)))]
           [left (max 0 (min (- c 2) (- cols width)))]
           [first (max 0 (min (- index (- shown 1)) (- n shown)))])
      (draw-box! g top left height width (prompt-label p))
      (when (> n 1)
        (let ([count (format " ~a/~a " (+ index 1) n)])
          (put-string! g (+ top height -1) (- (+ left width) 2 (string-length count)) count (UI 'ui.popup.border))))
      (if (= n 0)
          (put-string! g (+ top 1) (+ left 2) "no matches" (face-merge (UI 'ui.popup) (F 'ui.text.dim)) (+ left width -2))
          (let loop ([items (drop items first)] [i first] [row (+ top 1)])
            (when (and (pair? items) (< row (+ top height -1)))
              (draw-candidate! g row left width (car items) (= i index))
              (loop (cdr items) (+ i 1) (+ row 1)))))
      (and (< (- text-top 1) r bottom) (< (- gutter 1) c cols) (list r c 'bar))))

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

  ;; A dialog: a centered window, the input wrapping inside it, a little
  ;; above the middle as a form's would be. The box grows with the text up
  ;; to half the screen, then scrolls to keep the cursor in view.
  (define (draw-dialog! g rows cols p)
    (let* ([width (min (- cols 4) 80)]
           [inner (- width 4)]
           [input (if (eq? (prompt-style p) 'secret)
                      (make-string (string-length (prompt-input p)) #\•)
                      (prompt-input p))]
           [cursor (prompt-cursor p)]
           [starts (list->vector (wrap-starts input inner))]
           [nlines (vector-length starts)]
           [line-of (let loop ([i (- nlines 1)])
                      (if (or (= i 0) (<= (vector-ref starts i) cursor)) i (loop (- i 1))))]
           [visible (max 1 (min (max 3 nlines) (- (quotient rows 2) 2)))]
           [first (max 0 (- line-of (- visible 1)))]
           [height (+ visible 2)]
           [top (max 0 (- (quotient (- rows height) 2) (quotient rows 8)))]
           [left (quotient (- cols width) 2)]
           [face (UI 'ui.popup)]
           [line-text (lambda (i)
                        (let* ([end (if (< (+ i 1) nlines) (vector-ref starts (+ i 1)) (string-length input))]
                               [t (substring input (vector-ref starts i) end)])
                          (if (and (> (string-length t) 0) (char=? (string-ref t (- (string-length t) 1)) #\newline))
                              (substring t 0 (- (string-length t) 1))
                              t)))])
      (draw-box! g top left height width (prompt-label p))
      (if (and (string=? input "") (prompt-hint p))
          (put-string! g (+ top 1) (+ left 2) (prompt-hint p) (face-merge face (F 'ui.popup.info)) (+ left width -2))
          (do ([i first (+ i 1)] [r (+ top 1) (+ r 1)]) ((or (= i nlines) (= r (+ top 1 visible))))
            (put-string! g r (+ left 2) (line-text i) face (+ left width -1))))
      (let ([f " ⏎ send · esc cancel "])
        (put-string! g (+ top height -1) (max (+ left 1) (- (+ left width) 2 (string-width f))) f
                     (UI 'ui.popup.border) (+ left width -1)))
      (list (+ top 1 (- line-of first))
            (+ left 2 (string-width (substring input (vector-ref starts line-of) cursor)))
            'bar)))

  ;; A popup, at the right between rows top and bottom: its last lines.
  (define (draw-popup! g rows cols p top bottom)
    (let* ([now (lambda (x) (if (procedure? x) (x) x))]
           [title (now (popup-title p))]
           [footer (now (popup-footer p))]
           [width (min (- cols 2) (max 50 (quotient cols 2)) 100)]
           [inner (- width 4)]
           [left (- cols width 1)]
           [lines (apply append
                         (map (lambda (l) (map (lambda (t) (cons t (cdr l))) (wrap-text (car l) inner)))
                              ((popup-lines p))))]
           [height (min (- bottom top) (max 3 (+ 2 (length lines))))]
           [shown (let ([n (- height 2)]) (if (> (length lines) n) (drop lines (- (length lines) n)) lines))])
      (when (and (>= height 3) (> inner 0))
        (draw-box! g top left height width title)
        (let loop ([ls shown] [r (+ top 1)])
          (unless (null? ls)
            (put-string! g r (+ left 2) (car (car ls)) (face-merge (UI 'ui.popup) (F (cdr (car ls)))) (+ left width -2))
            (loop (cdr ls) (+ r 1))))
        (when footer
          (let ([f (string-append " " footer " ")])
            (put-string! g (+ top height -1) (max (+ left 1) (- (+ left width) 2 (string-width f))) f
                         (UI 'ui.popup.border) (+ left width -1)))))))

  ;; A line prompt's candidates, listed above the bottom row.
  (define (draw-completions! g rows cols p bottom)
    (let* ([items (prompt-items p)] [n (min 10 (length items))])
      (when (> n 0)
        (let* ([index (prompt-index p)] [first (max 0 (- index (- n 1)))])
          (let loop ([items (drop items first)] [i first] [r (- bottom n)])
            (when (and (pair? items) (< r bottom))
              (let ([face (UI (if (= i index) 'ui.menu.selected 'ui.menu))])
                (fill-row! g r 0 cols face)
                (put-string! g r 1 (car (car (car items))) face))
              (loop (cdr items) (+ i 1) (+ r 1))))))))

  ;; ---------------------------------------------------------------------------
  ;; Frames

  ;; Draw client c's frame and send it what changed. The client's own
  ;; state (prompt, layer, message, view) is current while drawing.
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
                   [height (- status-row text-top)]
                   [p (current-prompt)])
              (when tabs? (draw-bufferline! g b cols))
              (let ([gutter (draw-view! g v text-top height cols (not p))])
                (draw-status! g status-row v cols)
                (when (current-popup) (draw-popup! g rows cols (current-popup) text-top status-row))
                (let* ([bottom-cursor (draw-bottom! g (- rows 1) cols)]
                       [cursor
                        (cond
                         [(and p (eq? (prompt-style p) 'picker)) (draw-picker! g rows cols p)]
                         [(and p (memq (prompt-style p) '(dialog secret))) (draw-dialog! g rows cols p)]
                         [(and p (eq? (prompt-style p) 'menu)) (draw-menu! g cols p v gutter text-top status-row)]
                         [(and p (eq? (prompt-style p) 'line))
                          (draw-completions! g rows cols p status-row)
                          bottom-cursor]
                         ;; In insert mode a bar between characters;
                         ;; else the selection's head, which its face
                         ;; shows, so drawn by no one: for screen readers.
                         [else
                          (let* ([insert? (eq? (view-input-mode v) 'insert)]
                                 [pos (if insert? (sel-start (view-primary v)) (head-position v (view-primary v)))]
                                 [r (+ text-top (- (text-line-of (buffer-text b) pos) (view-top v)))]
                                 [col (+ gutter (- (display-column b pos) (view-left v)))])
                            (and (< -1 r status-row) (< (- gutter 1) col cols)
                                 (list r col (if insert? 'bar 'hidden))))])])
                  (when (and (layer-legend-visible?) (not p))
                    (draw-legend! g rows cols status-row))
                  (send-frame! c g cursor (list text-top status-row b (view-top v)))
                  (client-dirty?-set! c #f))))))))))
