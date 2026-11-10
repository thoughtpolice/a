;; widget.sls -- widgets: what overlays and components are drawn from
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A widget draws itself into a rectangle of a grid (canvas.sls): a box,
;; lines of text, a line of input, a list to pick from, a grid of keys.
;; It says how many rows it wants at a width, and it draws, returning
;; where its cursor is, (row col shape), or #f. Widgets nest: a frame holds
;; one (framed), a stack several, one above another. The editor's own overlays --
;; pickers, dialogs, menus, popups, the key legend (display.sls) -- are
;; drawn from them, and so can an extension's components and overlays be.
;; Keys are not a widget's: whoever shows them (a component, an overlay)
;; takes the keys, and changes what the widgets show.
;;
;;   (widget-draw! (framed "Title" (text-lines (list (cons "hello" (ui-face 'ui.popup)))))
;;                 canvas 0 0 5 30)
(library (quad widget)
  (export make-widget widget? widget-rows widget-draw!
          framed rule text-lines input-line text-area item-list key-grid stack empty-widget
          list-window
          ;; layout
          beside vrule padded centered
          ;; data
          table tree-rows tree tabs
          ;; state
          progress spinner scrollbar
          ;; controls
          checkbox choice button text-field)
  (import (chezscheme) (quad util) (quad face) (quad canvas))

  ;; measure: (cols) -> how many rows it wants that wide. paint: (g row
  ;; col rows cols) -> its cursor, or #f.
  (define-record-type widget (fields measure paint))

  (define (widget-rows w cols) ((widget-measure w) cols))
  (define (widget-draw! w g row col rows cols)
    (and (> rows 0) (> cols 0) ((widget-paint w) g row col rows cols)))

  (define empty-widget (make-widget (lambda (cols) 0) (lambda (g row col rows cols) #f)))

  ;; ---------------------------------------------------------------------------
  ;; Boxes and rules

  ;; child inside a border, titled title (a string or a thunk giving one,
  ;; or #f) at the top left;
  ;; options, an alist: (right . text) at the top right, (footer . text) at
  ;; the bottom right, each a string or a thunk, drawn in the border's face.
  ;; The child has the inside, less the border: it pads itself.
  (define framed
    (case-lambda
     [(title child) (framed title child '())]
     [(title child options)
      (let ([opt (lambda (k) (let ([v (assq k options)]) (and v (if (procedure? (cdr v)) ((cdr v)) (cdr v)))))])
        (make-widget
         (lambda (cols) (+ 2 (widget-rows child (- cols 2))))
         (lambda (g row col rows cols)
           (draw-box! g row col rows cols (if (procedure? title) (title) title))
           (let ([right (opt 'right)] [footer (opt 'footer)] [border (UI 'ui.popup.border)])
             (when right
               (put-string! g row (- (+ col cols) 2 (string-length right)) right border))
             (when footer
               (put-string! g (+ row rows -1) (max (+ col 1) (- (+ col cols) 2 (string-width footer))) footer
                            border (+ col cols -1))))
           (widget-draw! child g (+ row 1) (+ col 1) (- rows 2) (- cols 2)))))]))

  ;; A line across, in face (a face, or a name of one; the border's if #f).
  (define rule
    (case-lambda
     [() (rule #f)]
     [(face)
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (let ([f (cond [(not face) (UI 'ui.popup.border)] [(symbol? face) (UI face)] [else face])])
           (do ([c 0 (+ c 1)]) ((= c cols)) (put! g row (+ col c) #\x2500 f)))
         #f))]))

  ;; ---------------------------------------------------------------------------
  ;; Text

  ;; Lines of text, each (string . face), wrapped to the width less a column
  ;; of padding each side; a thunk giving them, too. With tail?, a widget
  ;; too short for them all shows their last.
  (define text-lines
    (case-lambda
     [(lines) (text-lines lines #f)]
     [(lines tail?)
      (let ([wrapped (lambda (cols)
                       (apply append
                              (map (lambda (l) (map (lambda (t) (cons t (cdr l))) (wrap-text (car l) (- cols 2))))
                                   (if (procedure? lines) (lines) lines))))])
        (make-widget
         (lambda (cols) (length (wrapped cols)))
         (lambda (g row col rows cols)
           (let* ([ls (wrapped cols)]
                  [ls (if (and tail? (> (length ls) rows)) (drop ls (- (length ls) rows)) ls)])
             (let loop ([ls ls] [r row])
               (when (and (pair? ls) (< r (+ row rows)))
                 (put-string! g r (+ col 1) (car (car ls)) (cdr (car ls)) (+ col cols -1))
                 (loop (cdr ls) (+ r 1)))))
           #f)))]))

  ;; A line of input: prefix (in prefix-face), then text (in face), the
  ;; cursor at index cursor of it. Each may be a thunk.
  (define (input-line prefix prefix-face text cursor face)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (let* ([text (now text)]
                [c (put-string! g row (+ col 1) (now prefix) prefix-face)])
           (put-string! g row c text face (+ col cols -1))
           (list row (+ c (string-width (substring text 0 (min (now cursor) (string-length text))))) 'bar))))))

  ;; Text being written, wrapping, a line at most, at least min-rows and at
  ;; most max-rows of it shown, scrolled to keep the cursor in view; hint
  ;; (in hint-face) while there is none. text and cursor may be thunks.
  (define (text-area text cursor face hint hint-face min-rows max-rows)
    (let* ([now (lambda (x) (if (procedure? x) (x) x))]
           [starts (lambda (cols) (list->vector (wrap-starts (now text) (- cols 2))))])
      (make-widget
       (lambda (cols) (max 1 (min (max min-rows (vector-length (starts cols))) max-rows)))
       (lambda (g row col rows cols)
         (let* ([input (now text)] [cursor (now cursor)] [starts (starts cols)]
                [nlines (vector-length starts)]
                [line-of (let loop ([i (- nlines 1)])
                           (if (or (= i 0) (<= (vector-ref starts i) cursor)) i (loop (- i 1))))]
                [first (max 0 (- line-of (- rows 1)))]
                [line-text (lambda (i)
                             (let* ([end (if (< (+ i 1) nlines) (vector-ref starts (+ i 1)) (string-length input))]
                                    [t (substring input (vector-ref starts i) end)])
                               (if (and (> (string-length t) 0) (char=? (string-ref t (- (string-length t) 1)) #\newline))
                                   (substring t 0 (- (string-length t) 1))
                                   t)))])
           (if (and (string=? input "") hint)
               (put-string! g row (+ col 1) hint hint-face (+ col cols -1))
               (do ([i first (+ i 1)] [r row (+ r 1)]) ((or (= i nlines) (= r (+ row rows))))
                 (put-string! g r (+ col 1) (line-text i) face (+ col cols))))
           (list (+ row (- line-of first))
                 (+ col 1 (string-width (substring input (vector-ref starts line-of) cursor)))
                 'bar))))))

  ;; ---------------------------------------------------------------------------
  ;; Lists

  ;; Which of n items a window of shown rows starts at, for the item at
  ;; index: 'center keeps it in the middle, as pickers do; 'follow keeps it
  ;; at the bottom once it gets there, as menus do.
  (define (list-window scroll n index shown)
    (case scroll
      [(center) (max 0 (min (- index (quotient shown 2)) (- n shown)))]
      [else (max 0 (min (- index (- shown 1)) (- n shown)))]))

  ;; Items to pick from, each ((text . value) . hits) as a prompt has them
  ;; (hits: the indices the query matched), the one at index selected.
  ;; items and index may be thunks. options, an alist: (scroll . 'center
  ;; or 'follow); (style . 'boxed), the text padded and its matches marked,
  ;; or 'plain, a row of text from the first column; (empty . text) shown
  ;; when there are none.
  (define item-list
    (case-lambda
     [(items index) (item-list items index '())]
     [(items index options)
      (let* ([now (lambda (x) (if (procedure? x) (x) x))]
             [opt (lambda (k d) (let ([v (assq k options)]) (if v (cdr v) d)))]
             [scroll (opt 'scroll 'follow)] [style (opt 'style 'boxed)] [empty (opt 'empty #f)])
        (make-widget
         (lambda (cols) (max (if empty 1 0) (length (now items))))
         (lambda (g row col rows cols)
           (let* ([items (now items)] [n (length items)] [index (now index)]
                  [first (list-window scroll n index rows)])
             (if (and (= n 0) empty)
                 (put-string! g row (+ col 1) empty (face-merge (UI 'ui.popup) (F 'ui.text.dim)) (+ col cols -1))
                 (let loop ([items (drop items (min first n))] [i first] [r row])
                   (when (and (pair? items) (< r (+ row rows)))
                     (if (eq? style 'plain)
                         (let ([face (UI (if (= i index) 'ui.menu.selected 'ui.menu))])
                           (fill-row! g r col (+ col cols) face)
                           (put-string! g r (+ col 1) (car (car (car items))) face))
                         (draw-item! g r col cols (car items) (= i index)))
                     (loop (cdr items) (+ i 1) (+ r 1))))))
           #f)))]))

  ;; An item, as a row from column col, cols wide: its text, padded, with
  ;; the characters the query matched marked.
  (define (draw-item! g r col cols item selected?)
    (let ([face (UI (if selected? 'ui.menu.selected 'ui.menu))] [hits (cdr item)] [text (car (car item))])
      (fill-row! g r col (+ col cols) face)
      (let ([ref (lambda (i) (string-ref text i))] [n (string-length text)])
        (let chars ([j 0] [c (+ col 1)])
          (when (and (< j n) (< c (+ col cols -1)))
            (let* ([k (grapheme-end ref j n)]
                   [hit? (exists (lambda (h) (<= j h (- k 1))) hits)])
              (put! g r c (if (= k (+ j 1)) (string-ref text j) (substring text j k))
                    (if hit? (face-merge face (F 'ui.menu.match)) face))
              (chars k (+ c (max 1 (grapheme-columns ref j k))))))))))

  ;; Keys and what they do, (key . label) each, in columns of at most
  ;; nrows: the key right-aligned in key-face, its label after in
  ;; label-face. col-w: each column's width.
  (define (key-grid cells nrows col-w key-face label-face)
    (let ([key-w (apply max 1 (map (lambda (c) (string-width (car c))) cells))])
      (make-widget
       (lambda (cols) nrows)
       (lambda (g row col rows cols)
         (let loop ([cs cells] [i 0])
           (unless (null? cs)
             (let* ([r (+ row (remainder i nrows))] [c (+ col 1 (* col-w (quotient i nrows)))])
               (when (< r (+ row rows))
                 (put-string! g r (+ c (- key-w (string-width (car (car cs))))) (car (car cs)) key-face)
                 (put-string! g r (+ c key-w 2) (cdr (car cs)) label-face (+ c col-w))))
             (loop (cdr cs) (+ i 1))))
         #f))))

  ;; ---------------------------------------------------------------------------
  ;; Stacks

  ;; Widgets one above another: parts, each (rows . widget), rows a number
  ;; or #f, and the parts given #f share what the others leave. The cursor
  ;; is the last part's that has one.
  (define (stack . parts)
    (make-widget
     (lambda (cols) (apply + (map (lambda (p) (or (car p) (widget-rows (cdr p) cols))) parts)))
     (lambda (g row col rows cols)
       (let* ([fixed (apply + (map (lambda (p) (or (car p) 0)) parts))]
              [flexible (length (filter (lambda (p) (not (car p))) parts))]
              [share (if (zero? flexible) 0 (quotient (max 0 (- rows fixed)) flexible))])
         (let loop ([ps parts] [r row] [cursor #f])
           (if (or (null? ps) (>= r (+ row rows)))
               cursor
               (let* ([h (min (or (car (car ps)) share) (- (+ row rows) r))]
                      [c (widget-draw! (cdr (car ps)) g r col h cols)])
                 (loop (cdr ps) (+ r h) (or c cursor)))))))))

  ;; ---------------------------------------------------------------------------
  ;; Layout

  ;; Widgets side by side, as stack has them one above another: parts, each
  ;; (cols . widget), cols a number or
  ;; #f, the #f ones sharing what the others leave. As tall as the tallest.
  (define (beside . parts)
    (let ([widths (lambda (cols)
                    (let* ([fixed (apply + (map (lambda (p) (or (car p) 0)) parts))]
                           [flexible (length (filter (lambda (p) (not (car p))) parts))]
                           [share (if (zero? flexible) 0 (quotient (max 0 (- cols fixed)) flexible))])
                      (map (lambda (p) (or (car p) share)) parts)))])
      (make-widget
       (lambda (cols) (apply max 0 (map (lambda (p w) (widget-rows (cdr p) w)) parts (widths cols))))
       (lambda (g row col rows cols)
         (let loop ([ps parts] [ws (widths cols)] [c col] [cursor #f])
           (if (or (null? ps) (>= c (+ col cols)))
               cursor
               (let* ([w (min (car ws) (- (+ col cols) c))]
                      [k (widget-draw! (cdr (car ps)) g row c rows w)])
                 (loop (cdr ps) (cdr ws) (+ c w) (or k cursor)))))))))

  ;; A line down, in face (a face or its name; the border's if #f).
  (define vrule
    (case-lambda
     [() (vrule #f)]
     [(face)
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (let ([f (cond [(not face) (UI 'ui.popup.border)] [(symbol? face) (UI face)] [else face])])
           (do ([r 0 (+ r 1)]) ((= r rows)) (put! g (+ row r) col #\x2502 f)))
         #f))]))

  ;; w, with top, right, bottom and left cells of space around it.
  (define (padded w top right bottom left)
    (make-widget
     (lambda (cols) (+ top bottom (widget-rows w (max 0 (- cols left right)))))
     (lambda (g row col rows cols)
       (widget-draw! w g (+ row top) (+ col left) (max 0 (- rows top bottom)) (max 0 (- cols left right))))))

  ;; w, cols wide and as tall as it wants, in the middle of what it is given.
  (define (centered w cols)
    (make-widget
     (lambda (c) (widget-rows w (min c cols)))
     (lambda (g row col rows c)
       (let* ([width (min c cols)] [height (min rows (widget-rows w width))])
         (widget-draw! w g (+ row (quotient (- rows height) 2)) (+ col (quotient (- c width) 2)) height width)))))

  ;; ---------------------------------------------------------------------------
  ;; Tables, trees and tabs

  (define (cell-text c) (if (pair? c) (car c) c))
  (define (cell-face c base) (if (pair? c) (face-merge base (if (symbol? (cdr c)) (F (cdr c)) (cdr c))) base))

  ;; Rows under a header: columns, each (title width align), width a number
  ;; or #f (as wide as its widest cell), align 'left or 'right; rows, lists
  ;; of cells, each a string or (string . face); the one at index selected
  ;; (#f: none), kept in view. rows and index may be thunks.
  (define (table columns rows index)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) (+ 1 (length (now rows))))
       (lambda (g row col height cols)
         (let* ([rows (now rows)] [index (now index)]
                [widths (map (lambda (c i)
                               (or (cadr c)
                                   (apply max (string-width (car c))
                                          (map (lambda (r) (string-width (cell-text (list-ref r i)))) rows))))
                             columns (iota (length columns)))]
                [draw-row
                 (lambda (r cells base)
                   (fill-row! g r col (+ col cols) base)
                   (let loop ([cs cells] [specs columns] [ws widths] [c (+ col 1)])
                     (when (and (pair? cs) (pair? specs) (< c (+ col cols)))
                       (let* ([text (cell-text (car cs))] [w (car ws)]
                              [x (if (eq? (caddr (car specs)) 'right) (+ c (max 0 (- w (string-width text)))) c)])
                         (put-string! g r x text (cell-face (car cs) base) (min (+ c w) (+ col cols)))
                         (loop (cdr cs) (cdr specs) (cdr ws) (+ c w 2))))))]
                [shown (max 0 (- height 1))]
                [first (if index (list-window 'follow (length rows) index shown) 0)])
           (draw-row row (map car columns) (face-merge (UI 'ui.menu) (F 'ui.text.focus)))
           (let loop ([rs (drop rows (min first (length rows)))] [i first] [r (+ row 1)])
             (when (and (pair? rs) (< r (+ row height)))
               (draw-row r (car rs) (UI (if (eqv? i index) 'ui.menu.selected 'ui.menu)))
               (loop (cdr rs) (+ i 1) (+ r 1)))))
         #f))))

  ;; The rows a tree shows: each root, and under each node open? says is
  ;; open its children, (children node) a list, as (guides label node) each:
  ;; guides the lines that lead to it ("│ ├─ "), label (label node).
  (define (tree-rows roots children label open?)
    (let walk ([nodes roots] [lead ""] [top? #t])
      (let loop ([ns nodes] [acc '()])
        (if (null? ns)
            (reverse acc)
            (let* ([n (car ns)] [last? (null? (cdr ns))]
                   [here (if top? "" (string-append lead (if last? "└─ " "├─ ")))]
                   [kids (if (open? n) (children n) '())]
                   [below (walk kids (if top? "" (string-append lead (if last? "   " "│  "))) #f)])
              (loop (cdr ns) (append (reverse below) (cons (list here (label n) n) acc))))))))

  ;; A tree's rows (tree-rows'), the one at index selected, kept in view:
  ;; the guides in face guide-face, a closed node with children marked ▸,
  ;; an open one ▾ (has-children? says which have).
  (define (tree rows index has-children? open?)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) (length (now rows)))
       (lambda (g row col height cols)
         (let* ([rows (now rows)] [index (now index)]
                [first (if index (list-window 'follow (length rows) index height) 0)])
           (let loop ([rs (drop rows (min first (length rows)))] [i first] [r row])
             (when (and (pair? rs) (< r (+ row height)))
               (let* ([x (car rs)] [base (UI (if (eqv? i index) 'ui.menu.selected 'ui.menu))]
                      [mark (cond [(not (has-children? (caddr x))) "  "] [(open? (caddr x)) "▾ "] [else "▸ "])])
                 (fill-row! g r col (+ col cols) base)
                 (let* ([c (put-string! g r (+ col 1) (car x) (face-merge base (F 'ui.text.dim)) (+ col cols))]
                        [c (put-string! g r c mark (face-merge base (F 'ui.popup.key)) (+ col cols))])
                   (put-string! g r c (cell-text (cadr x)) (cell-face (cadr x) base) (+ col cols))))
               (loop (cdr rs) (+ i 1) (+ r 1)))))
         #f))))

  ;; A row of tabs, titles, the one at index current.
  (define (tabs titles index)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (fill-row! g row col (+ col cols) (UI 'ui.statusline))
         (let loop ([ts (now titles)] [i 0] [c col])
           (when (and (pair? ts) (< c (+ col cols)))
             (let ([next (put-string! g row c (string-append " " (car ts) " ")
                                      (UI (if (= i (now index)) 'ui.statusline.normal 'ui.statusline))
                                      (+ col cols))])
               (loop (cdr ts) (+ i 1) next))))
         #f))))

  ;; ---------------------------------------------------------------------------
  ;; Progress

  ;; A bar filled to fraction (0 to 1; a thunk, too), with label after it.
  (define (progress fraction label)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (let* ([text (let ([l (now label)]) (if l (string-append " " l) ""))]
                [bar (max 1 (- cols 2 (string-width text)))]
                [f (max 0 (min 1 (now fraction)))]
                ;; Eighths of a cell, as block elements draw them.
                [eighths (exact (round (* f bar 8)))])
           (do ([i 0 (+ i 1)]) ((= i bar))
             (let ([e (max 0 (min 8 (- eighths (* i 8))))])
               (put! g row (+ col 1 i)
                     (if (= e 0) #\x2591 (string-ref "▏▎▍▌▋▊▉█" (- e 1)))
                     (UI (if (= e 0) 'ui.text.dim 'ui.popup.key)))))
           (put-string! g row (+ col 1 bar) text (UI 'ui.popup) (+ col cols)))
         #f))))

  ;; Something happening: a turning mark (by the time), then label.
  (define (spinner label)
    (let ([now (lambda (x) (if (procedure? x) (x) x))] [frames "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"])
      (make-widget
       (lambda (cols) 1)
       (lambda (g row col rows cols)
         (let ([i (mod (quotient (real-time) 80) (string-length frames))])
           (put! g row (+ col 1) (string-ref frames i) (UI 'ui.popup.key))
           (put-string! g row (+ col 3) (now label) (UI 'ui.popup) (+ col cols)))
         #f))))

  ;; w, with a bar down its right side saying which of total rows (from
  ;; first) it shows; nothing when it shows them all. first and total may
  ;; be thunks.
  (define (scrollbar w first total)
    (let ([now (lambda (x) (if (procedure? x) (x) x))])
      (make-widget
       (lambda (cols) (widget-rows w (- cols 1)))
       (lambda (g row col rows cols)
         (let ([cursor (widget-draw! w g row col rows (- cols 1))]
               [total (now total)] [first (now first)])
           (when (> total rows)
             (let* ([size (max 1 (quotient (* rows rows) total))]
                    [at (min (- rows size) (quotient (* first rows) total))])
               (do ([r 0 (+ r 1)]) ((= r rows))
                 (put! g (+ row r) (+ col cols -1)
                       (if (<= at r (+ at size -1)) #\x2503 #\x2502)
                       (UI (if (<= at r (+ at size -1)) 'ui.popup.key 'ui.popup.border))))))
           cursor)))))

  ;; ---------------------------------------------------------------------------
  ;; Controls: what forms are made of (form.sls), each drawn focused or not

  (define (control-face focused?) (UI (if focused? 'ui.menu.selected 'ui.popup)))

  ;; [x] label, checked? and focused? thunks.
  (define (checkbox label checked? focused?)
    (make-widget
     (lambda (cols) 1)
     (lambda (g row col rows cols)
       (let ([face (control-face (focused?))])
         (fill-row! g row col (+ col cols) face)
         (let ([c (put-string! g row (+ col 1) (if (checked?) "[x] " "[ ] ") (face-merge face (F 'ui.popup.key)))])
           (put-string! g row c label face (+ col cols))))
       #f)))

  ;; label: then each of options, the one at index chosen, (•) marking it.
  (define (choice label options index focused?)
    (make-widget
     (lambda (cols) 1)
     (lambda (g row col rows cols)
       (let ([face (control-face (focused?))])
         (fill-row! g row col (+ col cols) face)
         (let loop ([os options] [i 0] [c (put-string! g row (+ col 1) (string-append label "  ") face)])
           (when (and (pair? os) (< c (+ col cols)))
             (let* ([c (put-string! g row c (if (= i (index)) "(•) " "( ) ") (face-merge face (F 'ui.popup.key)))]
                    [c (put-string! g row c (car os) face (+ col cols))])
               (loop (cdr os) (+ i 1) (+ c 2))))))
       #f)))

  ;; [ label ], as a row of its own, focused? a thunk.
  (define (button label focused?)
    (make-widget
     (lambda (cols) 1)
     (lambda (g row col rows cols)
       (put-string! g row (+ col 1) (string-append "[ " label " ]")
                    (if (focused?) (UI 'ui.menu.selected) (face-merge (UI 'ui.popup) (F 'ui.popup.key)))
                    (+ col cols))
       #f)))

  ;; label: and a line of input, text and cursor thunks; its cursor shown
  ;; while focused? says it has the focus.
  (define (text-field label text cursor focused?)
    (make-widget
     (lambda (cols) 1)
     (lambda (g row col rows cols)
       (let* ([face (control-face (focused?))]
              [c (put-string! g row (+ col 1) (string-append label " ") face)])
         (fill-row! g row c (+ col cols) (UI 'ui.prompt))
         (let ([t (text)])
           (put-string! g row c t (UI 'ui.prompt) (+ col cols))
           (and (focused?) (list row (+ c (string-width (substring t 0 (min (cursor) (string-length t))))) 'bar))))))))
