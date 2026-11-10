;; form.sls -- forms: fields to fill in, and what to do with them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A form is fields -- a line of text, a check box, a choice among
;; options (on a line, or a list of them, one to a row), a button -- one
;; of them focused, drawn from widgets (widget.sls) and taking keys: tab
;; and the arrows move the focus, typing edits a text field, space checks a
;; box, left and right choose, up and down choose in a list, enter presses
;; a button or submits, escape cancels. show-form! shows one over the
;; panes, as an overlay; a component (a pane's) can show one too, with
;; form-widget and form-key. A checklist (show-checklist!) is one large
;; popup of entries, each opened to fields of its own, then what they all
;; said.
;;
;;   (show-form! "New Branch"
;;               (list (text-input 'name "Name" "")
;;                     (toggle 'push "Push it" #f)
;;                     (choose 'base "From" '("main" "here") 0))
;;               (lambda (values) (message "~s" values)))
(library (quad form)
  (export text-input toggle choose radio action
          make-form form? form-fields form-focus form-values form-widget form-key show-form!
          checklist-entry show-checklist!)
  (import (chezscheme) (quad util) (quad canvas) (quad widget) (quad editor))

  ;; kind: text, check, choice, radio or button. value: the text, whether
  ;; checked, the index chosen; extra: a choice's options, a list's
  ;; options, a button's procedure; cursor: a text field's; hook: a list's
  ;; (on-select value), or #f.
  (define-record-type field (fields kind name label (mutable value) extra (mutable cursor) hook))

  (define (text-input name label initial) (make-field 'text name label initial #f (string-length initial) #f))
  (define (toggle name label checked?) (make-field 'check name label checked? #f 0 #f))
  (define (choose name label options index) (make-field 'choice name label index options 0 #f))
  ;; A list to choose from, one option to a row: each (label value detail
  ;; enabled?), detail a string or #f, and an option not enabled? shown
  ;; but not chosen (one to come, say). (on-select value), if given, as
  ;; each is chosen: to show what it would be.
  (define radio
    (case-lambda
     [(name label options index) (radio name label options index #f)]
     [(name label options index on-select)
      (let ([enabled (filter (lambda (i) (cadddr (list-ref options i))) (iota (length options)))])
        (make-field 'radio name label
                    (cond [(memv index enabled) index] [(pair? enabled) (car enabled)] [else 0])
                    options 0 on-select))]))
  ;; A button: (proc form) when pressed.
  (define (action label proc) (make-field 'button #f label #f proc 0 #f))

  ;; submit: (proc values) once submitted, values an alist of each named
  ;; field's: its text, whether checked, the option chosen. cancel: a thunk.
  (define-record-type form (fields fields (mutable focus) submit cancel))

  (define (field-result x)
    (case (field-kind x)
      [(choice) (list-ref (field-extra x) (field-value x))]
      [(radio) (cadr (list-ref (field-extra x) (field-value x)))]
      [else (field-value x)]))

  (define (form-values f)
    (filter-map (lambda (x) (and (field-name x) (cons (field-name x) (field-result x)))) (form-fields f)))

  ;; The form's widget: a row for each field, and a list's options under
  ;; its label.
  (define (form-widget f)
    (apply stack
           (map (lambda (x i)
                  (let ([focused? (lambda () (= i (form-focus f)))])
                    (case (field-kind x)
                      [(text) (cons 1 (text-field (string-append (field-label x) ":")
                                                  (lambda () (field-value x)) (lambda () (field-cursor x)) focused?))]
                      [(check) (cons 1 (checkbox (field-label x) (lambda () (field-value x)) focused?))]
                      [(choice) (cons 1 (choice (string-append (field-label x) ":") (field-extra x)
                                                (lambda () (field-value x)) focused?))]
                      ;; A list with a heading is a group of its own: a
                      ;; blank row sets it apart from the fields after it.
                      [(radio)
                       (let* ([options (map (lambda (o) (list (car o) (caddr o) (cadddr o))) (field-extra x))]
                              [label? (and (field-label x) (not (string=? (field-label x) "")))]
                              [gap (if (and label? (< i (- (length (form-fields f)) 1))) 1 0)])
                         (cons (+ (length options) (if label? 1 0) gap)
                               (apply stack
                                      (append (if label? (list (cons 1 (text-lines (list (cons (field-label x) (UI 'ui.popup.title))))))
                                                  '())
                                              (list (cons (length options)
                                                          (radio-list options (lambda () (field-value x)) focused?)))
                                              (if (> gap 0) (list (cons gap empty-widget)) '())))))]
                      [else (cons 1 (button (field-label x) focused?))])))
                (form-fields f) (iota (length (form-fields f))))))

  (define (focused f) (and (pair? (form-fields f)) (list-ref (form-fields f) (form-focus f))))

  (define (move-focus! f step)
    (unless (null? (form-fields f))
      (form-focus-set! f (mod (+ (form-focus f) step) (length (form-fields f))))))

  (define (edit-text! x key text)
    (let* ([s (field-value x)] [c (field-cursor x)] [n (string-length s)])
      (cond
       [(member key '("backspace" "shift+backspace"))
        (when (> c 0)
          (field-value-set! x (string-append (substring s 0 (- c 1)) (substring s c n)))
          (field-cursor-set! x (- c 1)))
        #t]
       [(string=? key "delete")
        (when (< c n) (field-value-set! x (string-append (substring s 0 c) (substring s (+ c 1) n))))
        #t]
       [(string=? key "left") (field-cursor-set! x (max 0 (- c 1))) #t]
       [(string=? key "right") (field-cursor-set! x (min n (+ c 1))) #t]
       [(member key '("home" "ctrl+a")) (field-cursor-set! x 0) #t]
       [(member key '("end" "ctrl+e")) (field-cursor-set! x n) #t]
       [(string=? key "ctrl+u") (field-value-set! x (substring s c n)) (field-cursor-set! x 0) #t]
       [text
        (field-value-set! x (string-append (substring s 0 c) text (substring s c n)))
        (field-cursor-set! x (+ c (string-length text)))
        #t]
       [else #f])))

  ;; Up (-1) or down (1) a list to the next option that can be chosen; past
  ;; its ends, the focus moves on.
  (define (radio-step! f x step)
    (let ([options (field-extra x)])
      (let loop ([i (+ (field-value x) step)])
        (cond
         [(or (< i 0) (>= i (length options))) (move-focus! f step)]
         [(cadddr (list-ref options i))
          (field-value-set! x i)
          (when (field-hook x) ((field-hook x) (cadr (list-ref options i))))]
         [else (loop (+ i step))]))))

  ;; Take a key (spec, and the text it types or #f): whether the form did.
  (define (form-key f key text)
    (let ([x (focused f)])
      (cond
       ;; A form of no fields: just text (a wizard's page), to go on from.
       [(not x)
        (cond [(string=? key "esc") ((form-cancel f))] [(string=? key "enter") ((form-submit f) '())])
        #t]
       [(and (eq? (field-kind x) 'radio) (member key '("up" "down")))
        (radio-step! f x (if (string=? key "up") -1 1))
        #t]
       [(member key '("tab" "down")) (move-focus! f 1) #t]
       [(member key '("shift+tab" "up")) (move-focus! f -1) #t]
       [(string=? key "esc") ((form-cancel f)) #t]
       [(string=? key "enter")
        (if (eq? (field-kind x) 'button) ((field-extra x) f) ((form-submit f) (form-values f)))
        #t]
       [(eq? (field-kind x) 'text) (edit-text! x key text)]
       [(and (eq? (field-kind x) 'check) (string=? key "space"))
        (field-value-set! x (not (field-value x)))
        #t]
       [(and (eq? (field-kind x) 'choice) (member key '("left" "right")))
        (field-value-set! x (mod (+ (field-value x) (if (string=? key "left") -1 1)) (length (field-extra x))))
        #t]
       ;; Nothing else gets past a form: it is in front of everything.
       [else #t])))

  ;; The rectangle for widget w over area a: as wide as width at most, as
  ;; tall as it wants (or the area allows), centered.
  (define (centered-in a w width)
    (let* ([width (min (- (area-cols a) 4) width)]
           [height (min (- (area-rows a) 2) (widget-rows w width))])
      (list (max 0 (quotient (- (area-rows a) height) 2)) (max 0 (quotient (- (area-cols a) width) 2))
            height width)))

  ;; Show a form titled title over the current client's panes, centered:
  ;; (submit values) once enter submits it, (cancel) if escape cancels it;
  ;; either way it goes. Returns the form.
  (define show-form!
    (case-lambda
     [(title fields submit) (show-form! title fields submit void)]
     [(title fields submit cancel)
      (letrec* ([o #f]
                [c (current-client)]
                [done (lambda () (with-client c (lambda () (hide-overlay! o))))]
                [f (make-form fields 0
                              (lambda (vals) (done) (submit vals))
                              (lambda () (done) (cancel)))]
                [w (framed title (padded (form-widget f) 1 1 0 1)
                           '((footer . " ⏎ submit · tab next · esc cancel ")))])
        (set! o (make-overlay 'form (lambda (a) (centered-in a w 70)) w
                              (lambda (key text) (form-key f key text))))
        (show-overlay! o)
        f)]))

  ;; ---------------------------------------------------------------------------
  ;; Checklists

  ;; An entry of a checklist: a title; (summary values), what it is set
  ;; to now, as a string, values every entry's (an alist, as form-values);
  ;; lines of text above its fields, each (string . face-name), or a
  ;; procedure from those values to them; and its fields.
  (define-record-type entry (fields title summary lines fields))
  (define (checklist-entry title summary lines fields) (make-entry title summary lines fields))

  ;; What a form's fields are set to, to put back.
  (define (form-snapshot f) (map (lambda (x) (cons (field-value x) (field-cursor x))) (form-fields f)))
  (define (form-restore! f snapshot)
    (for-each (lambda (x v)
                (unless (equal? (field-value x) (car v))
                  (field-value-set! x (car v))
                  (field-cursor-set! x (cdr v))
                  (when (field-hook x) ((field-hook x) (field-result x)))))
              (form-fields f) snapshot))

  ;; Show a checklist titled title over the current client's panes, as one
  ;; large popup: header (a widget: a banner, a welcome; given what the rest
;; leave, which may be less than it asks for) above its entries,
  ;; each checked once it is set, then buttons, each (label . proc). up and
  ;; down (and tab) move among them. Enter opens an entry, to its fields:
  ;; there enter is done, and checks it; escape puts its fields back as they
  ;; were. Enter on a button closes the checklist and calls (proc values),
  ;; values every entry's fields' (an alist, as form-values); escape there
  ;; closes it and calls (cancel).
  (define (show-checklist! title header entries buttons cancel)
    (letrec* ([c (current-client)]
              [n (length entries)]
              [count (+ n (length buttons))]
              [focus 0]
              [open #f]                 ; the entry open, or #f
              [snapshot #f]
              [o #f]
              [done (make-vector n #f)]
              [values-now (lambda () (apply append (map form-values (vector->list forms))))]
              [close! (lambda () (with-client c (lambda () (hide-overlay! o))))]
              [finish-entry! (lambda ()
                               (vector-set! done open #t)
                               (set! focus (min (+ open 1) (- count 1)))
                               (set! open #f))]
              [back! (lambda ()
                       (form-restore! (vector-ref forms open) snapshot)
                       (set! focus open)
                       (set! open #f))]
              [forms (list->vector (map (lambda (e) (make-form (entry-fields e) 0
                                                               (lambda (vals) (finish-entry!)) (lambda () (back!))))
                                        entries))]
              [title-width (+ 2 (apply max 0 (map (lambda (e) (string-width (entry-title e))) entries)))]
              ;; The entries, a row each, then the buttons, side by side.
              [rows-widget
               (make-widget
                (lambda (cols) (+ n 2))
                (lambda (g row col rows cols)
                  (let ([vals (values-now)])
                    (for-each
                     (lambda (e i)
                       (when (< i rows)
                         (let* ([r (+ row i)] [focused? (= i focus)]
                                [face (UI (if focused? 'ui.menu.selected 'ui.popup))]
                                [mark (if (vector-ref done i) "✓" "○")])
                           (fill-row! g r col (+ col cols) face)
                           (put-string! g r (+ col 2) mark
                                        (if focused? face (face-merge face (F (if (vector-ref done i) 'diff.plus 'ui.text.dim)))))
                           (put-string! g r (+ col 5) (entry-title e) (if focused? face (face-merge face (F 'ui.popup.title)))
                                        (+ col cols))
                           (put-string! g r (+ col 5 title-width) ((entry-summary e) vals)
                                        (if focused? face (face-merge face (F 'ui.text.dim))) (+ col cols)))))
                     entries (iota n))
                    (when (< (+ n 1) rows)
                      (let loop ([bs buttons] [i n] [cc (+ col 2)])
                        (when (pair? bs)
                          (let ([next (put-string! g (+ row n 1) cc (string-append "[ " (car (car bs)) " ]")
                                                   (if (= i focus) (UI 'ui.menu.selected)
                                                       (face-merge (UI 'ui.popup) (F 'ui.popup.key)))
                                                   (+ col cols))])
                            (loop (cdr bs) (+ i 1) (+ next 2))))))
                    #f)))]
              ;; The header gets what the entries and buttons leave: they
              ;; always show.
              [main (make-widget
                     (lambda (cols) (+ (widget-rows header cols) 1 (widget-rows rows-widget cols)))
                     (lambda (g row col rows cols)
                       (let* ([list-rows (widget-rows rows-widget cols)]
                              [header-rows (min (widget-rows header cols) (max 0 (- rows list-rows 1)))])
                         (widget-draw! header g row col header-rows cols)
                         (widget-draw! rows-widget g (+ row header-rows (if (> header-rows 0) 1 0)) col list-rows cols))))]
              [pages (list->vector
                      (map (lambda (e f)
                             (pile (text-lines (lambda () (list (cons (entry-title e) (face-merge (UI 'ui.popup) (F 'ui.popup.title))))))
                                   (padded empty-widget 1 0 0 0)
                                   (text-lines
                                    (lambda ()
                                      (map (lambda (l) (cons (car l) (face-merge (UI 'ui.popup) (F (cdr l)))))
                                           (let ([ls (entry-lines e)]) (if (procedure? ls) (ls (values-now)) ls)))))
                                   (padded empty-widget 1 0 0 0)
                                   (form-widget f)))
                           entries (vector->list forms)))]
              [current (lambda () (if open (vector-ref pages open) main))]
              [body (padded (make-widget (lambda (cols) (widget-rows (current) cols))
                                         (lambda (g row col rows cols) (widget-draw! (current) g row col rows cols)))
                            1 2 1 2)]
              [w (framed (lambda () (if open (format "~a · ~a" title (entry-title (list-ref entries open))) title))
                         body
                         `((footer . ,(lambda ()
                                        (if open
                                            " ⏎ done · ↑↓ choose · tab move · esc back "
                                            " ↑↓ move · ⏎ open · esc not now ")))))]
              [key (lambda (k text)
                     (cond
                      [open (form-key (vector-ref forms open) k text)]
                      [(member k '("down" "tab")) (set! focus (mod (+ focus 1) count))]
                      [(member k '("up" "shift+tab")) (set! focus (mod (- focus 1) count))]
                      [(and (member k '("enter" "space")) (< focus n))
                       (set! open focus)
                       (set! snapshot (form-snapshot (vector-ref forms focus)))]
                      [(string=? k "enter")
                       (let ([proc (cdr (list-ref buttons (- focus n)))] [vals (values-now)])
                         (close!)
                         (proc vals))]
                      [(string=? k "esc") (close!) (cancel)])
                     #t)])
      (set! o (make-overlay 'checklist
                            (lambda (a)
                              (let* ([width (min (- (area-cols a) 6) 96)]
                                     [height (min (- (area-rows a) 2)
                                                  (max (quotient (* 3 (area-rows a)) 4)
                                                       (widget-rows w width)
                                                       (+ 2 (widget-rows (padded main 1 2 1 2) (- width 2)))))])
                                (list (max 0 (quotient (- (area-rows a) height) 2)) (max 0 (quotient (- (area-cols a) width) 2))
                                      height width)))
                            w key))
      (show-overlay! o)
      o)))
