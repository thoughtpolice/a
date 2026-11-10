;; form.sls -- forms: fields to fill in, and what to do with them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A form is fields -- a line of text, a check box, a choice among
;; options, a button -- one of them focused, drawn from widgets
;; (widget.sls) and taking keys: tab and the arrows move the focus, typing
;; edits a text field, space checks a box, left and right choose, enter
;; presses a button or submits, escape cancels. show-form! shows one over
;; the panes, as an overlay; a component (a pane's) can show one too, with
;; form-widget and form-key.
;;
;;   (show-form! "New Branch"
;;               (list (text-input 'name "Name" "")
;;                     (toggle 'push "Push it" #f)
;;                     (choose 'base "From" '("main" "here") 0))
;;               (lambda (values) (message "~s" values)))
(library (quad form)
  (export text-input toggle choose action
          make-form form? form-fields form-focus form-values form-widget form-key show-form!)
  (import (chezscheme) (quad util) (quad canvas) (quad widget) (quad editor))

  ;; kind: text, check, choice or button. value: the text, whether
  ;; checked, the index chosen; extra: a choice's options, a button's
  ;; procedure; cursor: a text field's.
  (define-record-type field (fields kind name label (mutable value) extra (mutable cursor)))

  (define (text-input name label initial) (make-field 'text name label initial #f (string-length initial)))
  (define (toggle name label checked?) (make-field 'check name label checked? #f 0))
  (define (choose name label options index) (make-field 'choice name label index options 0))
  ;; A button: (proc form) when pressed.
  (define (action label proc) (make-field 'button #f label #f proc 0))

  ;; submit: (proc values) once submitted, values an alist of each named
  ;; field's: its text, whether checked, the option chosen. cancel: a thunk.
  (define-record-type form (fields fields (mutable focus) submit cancel))

  (define (field-result x)
    (case (field-kind x)
      [(choice) (list-ref (field-extra x) (field-value x))]
      [else (field-value x)]))

  (define (form-values f)
    (filter-map (lambda (x) (and (field-name x) (cons (field-name x) (field-result x)))) (form-fields f)))

  ;; The form's widget: a row for each field.
  (define (form-widget f)
    (apply stack
           (map (lambda (x i)
                  (let ([focused? (lambda () (= i (form-focus f)))])
                    (cons 1
                          (case (field-kind x)
                            [(text) (text-field (string-append (field-label x) ":")
                                                (lambda () (field-value x)) (lambda () (field-cursor x)) focused?)]
                            [(check) (checkbox (field-label x) (lambda () (field-value x)) focused?)]
                            [(choice) (choice (string-append (field-label x) ":") (field-extra x)
                                              (lambda () (field-value x)) focused?)]
                            [else (button (field-label x) focused?)]))))
                (form-fields f) (iota (length (form-fields f))))))

  (define (focused f) (list-ref (form-fields f) (form-focus f)))

  (define (move-focus! f step)
    (form-focus-set! f (mod (+ (form-focus f) step) (length (form-fields f)))))

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

  ;; Take a key (spec, and the text it types or #f): whether the form did.
  (define (form-key f key text)
    (let ([x (focused f)])
      (cond
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
        (set! o (make-overlay
                 'form
                 (lambda (a)
                   (let* ([width (min (- (area-cols a) 4) 70)] [height (+ 3 (length fields))])
                     (list (max 0 (quotient (- (area-rows a) height) 2)) (quotient (- (area-cols a) width) 2)
                           height width)))
                 w
                 (lambda (key text) (form-key f key text))))
        (show-overlay! o)
        f)])))
