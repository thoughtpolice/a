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
(library (quad display)
  (export render-client! invalidate-client! define-status-segment! status-segments
          face-id)
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

  ;; ---------------------------------------------------------------------------
  ;; Grids

  (define-record-type grid (fields rows cols chars faces))

  (define (new-grid rows cols face)
    (make-grid rows cols
               (let ([v (make-vector rows)])
                 (do ([r 0 (+ r 1)]) ((= r rows) v) (vector-set! v r (make-vector cols #\space))))
               (let ([v (make-vector rows)])
                 (do ([r 0 (+ r 1)]) ((= r rows) v) (vector-set! v r (make-vector cols face))))))

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
      (let loop ([i 0] [col c])
        (if (or (= i (string-length s)) (>= col limit))
            col
            (let* ([ch (string-ref s i)] [w (char-width ch)])
              (cond
               [(= w 0) (loop (+ i 1) col)]
               [(> (+ col w) limit) col]
               [else
                (put! g r col ch face)
                (when (= w 2) (put! g r (+ col 1) 'wide face))
                (loop (+ i 1) (+ col w))]))))]))

  (define (fill-row! g r c0 c1 face)
    (do ([c c0 (+ c 1)]) ((>= c c1)) (put! g r c #\space face)))

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
    (logior (if (face-bold? f) 1 0) (if (face-italic? f) 2 0) (if (face-underline? f) 4 0)
            (if (face-undercurl? f) 8 0) (if (face-dim? f) 16 0) (if (face-reverse? f) 32 0)))

  ;; The client's state between frames: the grid it shows and the ids it
  ;; knows.
  (define-record-type frame (fields grid known))

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

  (define (send-frame! c g cursor)
    (let* ([old (client-frame c)]
           [full? (or (not old)
                      (not (= (grid-rows (frame-grid old)) (grid-rows g)))
                      (not (= (grid-cols (frame-grid old)) (grid-cols g))))]
           [known (if full? (make-eqv-hashtable) (frame-known old))]
           [prev (and (not full?) (frame-grid old))]
           [hl! (lambda (f)
                  (let ([id (face-id f)])
                    (unless (hashtable-contains? known id)
                      (hashtable-set! known id #t)
                      (client-send! c (list "hl" id (face-fg f) (face-bg f) (face-flags f))))
                    id))])
      (when full? (client-send! c (list "grid" (grid-rows g) (grid-cols g))))
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
                (client-send! c (list "line" r first (row-cells g r first (+ last 1) hl!))))))))
      (client-send! c (if cursor (list "cursor" (car cursor) (cadr cursor) (symbol->string (caddr cursor)))
                          '("cursor" #f)))
      (client-send! c '("flush"))
      (client-frame-set! c (make-frame g known))))

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

  ;; Overlay faces per position on a line: selections and cursors, and the
  ;; cursors of the other clients' views of the same buffer.
  (define (selection-spans v line-start line-end)
    (let ([insert? (eq? (view-input-mode v) 'insert)]
          [others (filter-map (lambda (o)
                                (and (not (eq? o v)) (memq (view-client o) (clients))
                                     (eq? (client-view (view-client o)) o)
                                     (let ([h (head-position o (view-primary o))])
                                       (and (<= line-start h (+ line-end 1))
                                            (list h (+ h 1) (F 'ui.cursor.other))))))
                              (buffer-views (view-buffer v)))])
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
      (let loop ([i s] [col 0] [ss syntax-spans])
        (let ([ss (let skip ([ss ss]) (if (and (pair? ss) (<= (cadr (car ss)) i)) (skip (cdr ss)) ss))]
              [sc (+ gutter (- col left))])
          (cond
           [(> i e) (void)]
           [(= i e)
            ;; The newline: a space, so a selection or a cursor on it shows.
            (when (visible? sc) (put! g row sc #\space (face-for i ss)))]
           [else
            (let* ([ch (text-ref t i)]
                   [w (if (char=? ch #\tab) (- tw (modulo col tw)) (char-width ch))]
                   [face (face-for i ss)])
              (cond
               [(= w 0)
                ;; A combining mark joins the cell before it.
                (let ([pc (- sc 1)])
                  (when (visible? pc)
                    (let ([prev (vector-ref (vector-ref (grid-chars g) row) pc)])
                      (put! g row pc
                            (string-append (cond [(char? prev) (string prev)] [(string? prev) prev] [else ""])
                                           (string ch))
                            (face-at g row pc)))))]
               [(char=? ch #\tab)
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
              (loop (+ i 1) (+ col w) ss))])))))

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
           [jumps (jump-labels)])
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
                            (selection-spans v s e) match tw ws?)))))
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
             (let ([n (length (filter (lambda (o) (and (not (eq? o v)) (memq (view-client o) (clients))
                                                       (eq? (client-view (view-client o)) o)))
                                      (buffer-views (view-buffer v))))])
               (and (> n 0) (cons (format "+~a  " n) 'ui.statusline.dim)))))
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
  (define (draw-picker! g rows cols p)
    (let* ([width (min (- cols 4) 100)]
           [height (min (- rows 4) 24)]
           [top (quotient (- rows height) 2)]
           [left (quotient (- cols width) 2)]
           [items (prompt-items p)]
           [n (length items)]
           [visible (- height 4)]
           [index (prompt-index p)]
           [first (max 0 (min (- index (quotient visible 2)) (- n visible)))])
      (draw-box! g top left height width (prompt-label p))
      (let ([count (format " ~a/~a " (if (= n 0) 0 (+ index 1)) n)])
        (put-string! g top (- (+ left width) 2 (string-length count)) count (UI 'ui.popup.border)))
      (let ([col (put-string! g (+ top 1) (+ left 2) "❯ " (UI 'ui.prompt.label))])
        (put-string! g (+ top 1) col (prompt-input p) (UI 'ui.popup) (+ left width -2))
        (do ([c 1 (+ c 1)]) ((>= c (- width 1))) (put! g (+ top 2) (+ left c) #\─ (UI 'ui.popup.border)))
        (let loop ([items (drop items first)] [i first] [r (+ top 3)])
          (when (and (pair? items) (< r (+ top height -1)))
            (let* ([item (car items)] [selected? (= i index)]
                   [face (UI (if selected? 'ui.menu.selected 'ui.menu))]
                   [hits (cdr item)])
              (fill-row! g r (+ left 1) (+ left width -1) face)
              (let ([text (car (car item))])
                (let chars ([j 0] [c (+ left 2)])
                  (when (and (< j (string-length text)) (< c (+ left width -2)))
                    (let ([ch (string-ref text j)])
                      (put! g r c ch (if (memv j hits) (face-merge face (F 'ui.menu.match)) face))
                      (chars (+ j 1) (+ c (max 1 (char-width ch))))))))
              (loop (cdr items) (+ i 1) (+ r 1)))))
        (list (+ top 1) (+ col (string-width (substring (prompt-input p) 0 (prompt-cursor p)))) 'bar))))

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
              (let ([gutter (draw-buffer! g v text-top height cols (not p))])
                (draw-status! g status-row v cols)
                (let* ([bottom-cursor (draw-bottom! g (- rows 1) cols)]
                       [cursor
                        (cond
                         [(and p (eq? (prompt-style p) 'picker)) (draw-picker! g rows cols p)]
                         [(and p (eq? (prompt-style p) 'line))
                          (draw-completions! g rows cols p status-row)
                          bottom-cursor]
                         [(eq? (view-input-mode v) 'insert)
                          (let* ([t (buffer-text b)] [pos (sel-start (view-primary v))]
                                 [line (text-line-of t pos)]
                                 [r (+ text-top (- line (view-top v)))]
                                 [col (+ gutter (- (display-column b pos) (view-left v)))])
                            (and (< -1 r status-row) (< (- gutter 1) col cols) (list r col 'bar)))]
                         [else #f])])
                  (when (and (layer-legend-visible?) (not p))
                    (draw-legend! g rows cols status-row))
                  (send-frame! c g cursor)
                  (client-dirty?-set! c #f))))))))))
