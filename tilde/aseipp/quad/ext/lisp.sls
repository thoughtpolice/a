;; lisp.sls -- Scheme and other Lisps: highlighting, s-expressions, indentation
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The NODE selection mode walks s-expressions exactly in these buffers, and
;; a new line is indented the way Scheme code is: under a call's second
;; element, or by two inside body forms.
(library (quad ext lisp)
  (export scheme-syntax scheme-mode lisp-indent lisp-body-forms)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (quad editor) (quad commands))

  (define scheme-syntax
    (make-syntax
     'scheme #t '(";") '(("#|" . "|#")) '(#\") lisp-word-char?
     (keyword-table
      '(keyword.special "define" "define-syntax" "define-record-type" "define-values"
                        "library" "define-command" "define-major-mode" "define-variable"
                        "define-key" "define-theme" "define-ftype" "module")
      '(keyword "lambda" "case-lambda" "let" "let*" "letrec" "letrec*" "let-values"
                "let*-values" "if" "cond" "case" "when" "unless" "begin" "do" "and" "or"
                "set!" "quote" "quasiquote" "unquote" "syntax-rules" "syntax-case"
                "with-syntax" "import" "export" "parameterize" "guard" "else" "=>"
                "delay" "fluid-let" "named-lambda" "rec" "syntax" "quasisyntax"
                "unsyntax" "dynamic-wind" "assert" "receive" "include")
      '(constant.builtin "#t" "#f" "#true" "#false"))
     '("define" "define-syntax" "define-values" "define-command" "define-major-mode"
       "define-variable" "define-record-type")
     #f ";; " "  "))

  ;; Forms whose body is indented by two, not aligned with their arguments.
  (define lisp-body-forms
    '("define" "lambda" "let" "let*" "letrec" "letrec*" "let-values" "let*-values"
      "when" "unless" "do" "case-lambda" "library" "define-syntax" "syntax-rules"
      "syntax-case" "with-syntax" "parameterize" "guard" "define-record-type"
      "call-with-port" "call-with-values" "dynamic-wind" "fluid-let" "begin" "case"
      "define-command" "define-major-mode" "module" "rec" "named-lambda"
      "define-values" "with-exception-handler" "call/cc" "let-syntax"))

  ;; The column a new line at pos should start at, from the innermost
  ;; unclosed list around it: aligned under its second element, or indented
  ;; by two for body forms and lists whose head stands alone.
  (define (lisp-indent b pos)
    (let* ([t (buffer-text b)] [root (buffer-tree b)]
           [n (let loop ([n (node-at root pos pos)])
                (cond
                 [(not n) #f]
                 [(and (node-list? n) (node-parent n) (< (node-start n) pos)
                       (or (= (node-end n) (text-length t))
                           (> (node-end n) pos)
                           (not (memv (text-ref t (- (node-end n) 1)) '(#\) #\] #\})))))
                  n]
                 [else (loop (node-parent n))]))])
      (if (not n)
          0
          (let* ([open (let find ([i (node-start n)])
                         (if (memv (text-ref t i) '(#\( #\[ #\{)) i (find (+ i 1))))]
                 [col (text-column t open)]
                 [kids (filter (lambda (k) (< (node-start k) pos)) (vector->list (node-kids n)))])
            (cond
             [(null? kids) (+ col 1)]
             [(memv (text-ref t open) '(#\[ #\{)) (+ col 1)]
             [else
              (let* ([head (car kids)]
                     [head-text (text-substring t (node-start head) (node-end head))])
                (cond
                 [(node-list? head) (+ col 1)]
                 [(or (member head-text lisp-body-forms)
                      (string-prefix? "define" head-text)
                      (string-prefix? "with-" head-text))
                  (+ col 2)]
                 [(and (pair? (cdr kids))
                       (= (text-line-of t (node-start (cadr kids))) (text-line-of t (node-start head))))
                  (text-column t (node-start (cadr kids)))]
                 [else (+ col 1)]))])))))

  (define scheme-mode (define-major-mode! 'scheme scheme-syntax))

  (at-load
   (major-mode-hook-set! scheme-mode
                         (lambda (b)
                           (set-local! 'indent-unit "  " b)
                           (set-local! 'indent-function lisp-indent b)))
   (add-auto-mode! '("ss" "sls" "scm" "sps" "sld" "sch" "rkt" "el" "lisp" "cl" "clj" "fnl" "janet" "lean") 'scheme)))
