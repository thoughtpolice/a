;; rust.sls -- (chez rust): the Scheme side of Rust procedures
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The libraries chez::library! generates (see quad/chez-rs) bind their
;; procedures with define-native, from this library. A Rust procedure that
;; fails returns the broken-weak-pointer object, which no Rust value converts
;; to, having left its message behind; define-native turns that into an
;; error raised in Scheme. Rust objects arrive as handles, pairs of a type
;; name and an address, which a guardian frees once unreferenced.
(library (chez rust)
  (export define-native native-object? native-object-type native-drop! native-drop-unreferenced!)
  (import (chezscheme))

  ;; The runtime's entries, resolved when first used: the program registers
  ;; them (Library::register) after its heap is built.
  (define-syntax define-entry
    (syntax-rules ()
      [(_ name cname (arg ...) ret)
       (define name
         (let ([p #f])
           (lambda args
             (unless p (set! p (foreign-procedure cname (arg ...) ret)))
             (apply p args))))]))

  (define-entry last-error "chez-rust:last-error" () ptr)
  (define-entry drop-handle "chez-rust:drop" (ptr) ptr)
  (define-entry new-handles "chez-rust:new-handles" () ptr)

  (define (native-object? x)
    (and (pair? x) (symbol? (car x)) (exact? (cdr x)) (integer? (cdr x))))
  (define (native-object-type x) (car x))

  ;; Drop the Rust value behind a handle now; using the handle afterwards
  ;; is an error, from Rust.
  (define (native-drop! x) (drop-handle x) (void))

  ;; Handles Scheme no longer references go to the guardian, which is
  ;; emptied after each collection, or on request.
  (define guardian (make-guardian))

  (define (native-drop-unreferenced!)
    (let loop ()
      (let ([x (guardian)])
        (when x (drop-handle x) (loop)))))

  (define (adopt!) (for-each guardian (new-handles)))

  (define install-collect-handler
    (let ([next (collect-request-handler)])
      (collect-request-handler (lambda () (next) (native-drop-unreferenced!)))
      #t))

  (define (native-result who r objects?)
    (when objects? (adopt!))
    (if (bwp-object? r)
        (error who (last-error))
        r))

  ;; (define-native name "library:name" (param ...) objects?)
  (define-syntax define-native
    (lambda (x)
      (syntax-case x ()
        [(_ name cname (arg ...) objects?)
         (with-syntax ([(type ...) (map (lambda (a) #'ptr) #'(arg ...))])
           #'(define name
               (let ([p #f])
                 (lambda (arg ...)
                   (unless p (set! p (foreign-procedure cname (type ...) ptr)))
                   (native-result 'name (p arg ...) objects?)))))]))))
