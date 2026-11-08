;; compile.ss -- compile one target's Scheme: its libraries, or a program
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --script compile.ss key=value ...
;;
;;   src=DIR        the target's sources, laid out by library name
;;                  (DIR/quad/text.sls holds (quad text)), except that a
;;                  library no other in the target imports can be anywhere
;;   lib=REL        a library source under src, repeated for each
;;   program=REL    or: a top-level program under src
;;   dep=DIR        the objects of a dependency, laid out the same way,
;;                  repeated; dependencies are read as objects only
;;   out=DIR        where the objects go (for a program, the object file)
;;   manifest=FILE  for libraries: the libraries compiled, each after the
;;                  ones it imports, as ((name "REL.so") ...)
;;   opt=N debug=yes|no
(import (chezscheme))

(define args
  (map (lambda (a)
         (let ([i (let loop ([i 0]) (if (char=? (string-ref a i) #\=) i (loop (+ i 1))))])
           (cons (string->symbol (substring a 0 i)) (substring a (+ i 1) (string-length a)))))
       (command-line-arguments)))
(define (arg k) (let ([p (assq k args)]) (and p (cdr p))))
(define (args-of k) (map cdr (filter (lambda (p) (eq? (car p) k)) args)))

(define src (arg 'src))
(define out (arg 'out))

(reset-handler (lambda () (exit 1)))
(optimize-level (string->number (or (arg 'opt) "2")))
(generate-inspector-information (equal? (arg 'debug) "yes"))
(generate-procedure-source-information #t)
(fasl-compressed #t)
(compile-file-message #f)
(undefined-variable-warnings #t)
(import-notify #f)

(define (mkdir-p dir)
  (unless (or (string=? dir "") (file-exists? dir))
    (mkdir-p (path-parent dir))
    (mkdir dir)))

;; Objects go where imports look for them: by library name.
(define (name->path name)
  (let loop ([parts (map symbol->string (filter symbol? name))])
    (if (null? (cdr parts)) (car parts) (string-append (car parts) "/" (loop (cdr parts))))))
(define (object-rel name) (string-append (name->path name) ".so"))

;; The target's own sources compile into out as they are imported; its
;; dependencies' objects are found, already compiled, in their directories.
(define (setup-libraries! own-out)
  (library-directories
   (cons (cons src own-out) (map (lambda (d) (cons d d)) (args-of 'dep))))
  (compile-imported-libraries #t))

(define (library-name rel)
  (let ([form (call-with-input-file (string-append src "/" rel) read)])
    (unless (and (pair? form) (eq? (car form) 'library))
      (errorf 'compile "~a is not a library" rel))
    (cadr form)))

;; Drop any version from a library reference.
(define (strip-version name) (filter symbol? name))

(cond
 [(arg 'program)
  (let ([rel (arg 'program)])
    (mkdir-p (path-parent out))
    (let ([tmp (string-append (path-parent out) "/.objects")])
      (mkdir-p tmp)
      (setup-libraries! tmp))
    (compile-program (string-append src "/" rel) out))]
 [else
  (mkdir-p out)
  (setup-libraries! out)
  (let* ([rels (args-of 'lib)]
         [names (map library-name rels)])
    (for-each
     (lambda (rel name)
       (let ([obj (string-append out "/" (object-rel name))])
         ;; A library another one imported is compiled already.
         (unless (file-exists? obj)
           (mkdir-p (path-parent obj))
           (compile-library (string-append src "/" rel) obj))))
     rels names)
    ;; Each library after the ones of this target it imports.
    (let ([order (let visit ([todo names] [done '()])
                   (fold-left
                    (lambda (done name)
                      (if (member name done)
                          done
                          (let ([own (filter (lambda (r) (member r names))
                                             (map strip-version (library-requirements name)))])
                            (append (visit own done) (list name)))))
                    done todo))])
      (call-with-output-file (arg 'manifest)
        (lambda (p)
          (write (map (lambda (name) (list name (object-rel name))) order) p)
          (newline p)))))])
