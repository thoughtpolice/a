;; widgets.ss -- widgets, drawn on a canvas, and overlays an extension shows
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 16 60)

;; What a widget draws, rows by cols, as strings, and its cursor.
(define (drawn w rows cols)
  (let* ([g (new-grid rows cols (ui-face 'ui))]
         [cursor (widget-draw! w g 0 0 rows cols)])
    (values (map (lambda (r)
                   (apply string-append
                          (map (lambda (ch) (if (char? ch) (string ch) ch)) (vector->list (vector-ref (grid-chars g) r)))))
                 (iota rows))
            cursor)))

(define face (ui-face 'ui.popup))

;; A frame around lines, which wrap.
(let-values ([(rows cursor) (drawn (framed "Notes" (text-lines (list (cons "one two three four" face)))) 4 12)])
  (expect-equal "framed text" rows '("╭─ Notes ──╮" "│ one two  │" "│ three    │" "╰──────────╯")))

;; A line of input, its cursor where it is.
(let-values ([(rows cursor) (drawn (input-line "> " face "hello" 2 face) 1 12)])
  (expect-equal "input" (car rows) " > hello    ")
  (expect-equal "its cursor" cursor '(0 5 bar)))

;; A list keeps its selected item in view.
(let* ([items (map (lambda (i) (cons (cons (format "item ~a" i) i) '())) (iota 10))]
       [rows (lambda (scroll index)
               (let-values ([(rows cursor) (drawn (item-list items index (list (cons 'scroll scroll))) 3 10)])
                 (map string-trim rows)))])
  (expect-equal "following" (rows 'follow 6) '("item 4" "item 5" "item 6"))
  (expect-equal "centered" (rows 'center 6) '("item 5" "item 6" "item 7")))

;; A stack shares what is left among its flexible parts.
(let-values ([(rows cursor) (drawn (stack (cons 1 (rule)) (cons #f (text-lines (list (cons "body" face))))
                                          (cons 1 (input-line "" face "x" 1 face)))
                                   4 8)])
  (expect-equal "stack" (map string-trim rows) '("────────" "body" "" "x"))
  (expect-equal "the cursor is the input's" cursor '(3 2 bar)))

;; An extension's overlay, over the panes, taking the keys it wants.
(define taken '())
(define note
  (make-overlay 'note
                (lambda (a) (list 2 10 3 20))
                (framed "Note" (text-lines (list (cons "press x" face))))
                (lambda (key text) (and (string=? key "x") (begin (set! taken (cons key taken)) #t)))))
(headless-buffer! "under it" 'text)
(show-overlay! note)
(redraw!)
(check "it is shown" (on-screen? "press x"))
(press! "x")
(expect-equal "it takes its keys" taken '("x"))
(press! "l")
(check "and leaves the others" (= 1 (length taken)))
(hide-overlay! note)
(redraw!)
(check "hidden" (not (on-screen? "press x")))

;; Side by side, with a rule between.
(let-values ([(rows cursor) (drawn (beside (cons 6 (text-lines (list (cons "left" face)))) (cons 1 (vrule))
                                           (cons #f (text-lines (list (cons "right" face)))))
                                   1 14)])
  (expect-equal "beside" (car rows) " left │ right "))

;; A table: a header, columns as wide as their widest cell, aligned.
(let-values ([(rows cursor) (drawn (table '(("name" #f left) ("size" #f right))
                                          '(("a.txt" "12") ("longer.c" "3400"))
                                          1)
                                   3 22)])
  (expect-equal "table" (map string-trim-right rows) '(" name      size" " a.txt       12" " longer.c  3400")))

;; A tree, with the guides that lead to each node; closed ones' children
;; are not shown.
(define fs '("root" ("src" ("main.c") ("util.c")) ("README")))
(define closed '())
(define (kids n) (cdr n))
(define rows-now (tree-rows (list fs) kids car (lambda (n) (not (member (car n) closed)))))
(expect-equal "tree rows" (map (lambda (r) (string-append (car r) (cadr r))) rows-now)
              '("root" "├─ src" "│  ├─ main.c" "│  └─ util.c" "└─ README"))
(set! closed '("src"))
(let-values ([(rows cursor) (drawn (tree (tree-rows (list fs) kids car (lambda (n) (not (member (car n) closed)))) 0
                                         (lambda (n) (pair? (cdr n))) (lambda (n) (not (member (car n) closed))))
                                   3 20)])
  (expect-equal "a closed node" (map string-trim-right rows) '(" ▾ root" " ├─ ▸ src" " └─   README")))

;; Progress, in eighths of a cell.
(let-values ([(rows cursor) (drawn (progress 1/2 "half") 1 15)])
  (expect-equal "progress" (car rows) " ████░░░░ half "))

;; A form: tab moves the focus, typing fills a field, space checks, the
;; arrows choose, enter submits what it holds.
(define submitted #f)
(show-form! "New" (list (text-input 'name "Name" "") (toggle 'push "Push it" #f) (choose 'from "From" '("main" "here") 0))
            (lambda (vals) (set! submitted vals)))
(redraw!)
(check "the form is shown" (on-screen? "Push it"))
(type! "feat")
(press! "tab" "space" "tab" "right" "enter")
(expect-equal "what it submitted" submitted '((name . "feat") (push . #t) (from . "here")))
(redraw!)
(check "and it went" (not (on-screen? "Push it")))
