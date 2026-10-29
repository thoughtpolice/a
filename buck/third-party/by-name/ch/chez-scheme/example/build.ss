;; build.ss -- compile the application into a boot file
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
;;
;; Run from the root of the source tree, as
;;
;;   scheme -q --script build.ss key=value ...
;;
;; with the keys below. The application is compiled as a whole program, then
;; wrapped into <out>/<app>.boot, which names the Chez boot files it needs.
;; The relative paths of the sources are recorded in the profile and
;; inspector information, so a profiled build has to run from a tree with the
;; same layout to report on its sources.
(import (chezscheme))

(define (arg key default)
  (let ([prefix (string-append key "=")])
    (let loop ([args (command-line-arguments)])
      (cond
       [(null? args) default]
       [(and (>= (string-length (car args)) (string-length prefix))
             (string=? prefix (substring (car args) 0 (string-length prefix))))
        (substring (car args) (string-length prefix) (string-length (car args)))]
       [else (loop (cdr args))]))))

(define (yes? key) (string=? "yes" (arg key "no")))

(define app   (arg "app" "hello"))
(define out   (arg "out" "."))
(define entry (arg "entry" "src/c/_entry.ss"))
(define (output ext) (format "~a/~a.~a" out app ext))

;; 'petite' boots the interpreter-only runtime; 'chez' adds the compiler.
(define boot-prereqs
  (let ([runtime (arg "runtime" "petite")])
    (cond
     [(string=? runtime "petite") '("petite")]
     [(string=? runtime "chez") '("scheme" "petite")]
     [else (errorf 'build "runtime must be petite or chez, not ~s" runtime)])))

;; Any error is fatal, rather than a return to the REPL.
(reset-handler (lambda () (exit 1)))

(optimize-level (string->number (arg "opt" "1")))
(generate-inspector-information (yes? "debug"))
(compile-profile (and (yes? "profile") 'source))
(generate-wpo-files #t)
(fasl-compressed #t)
(compile-imported-libraries #t)
(undefined-variable-warnings #t)
(compile-file-message #f)

;; Counts from a profiled run of the same sources, to optimize with.
(let ([data (arg "profile-data" #f)])
  (when data (profile-load-data data)))

(printf "compiling application...")
(compile-program entry (output "so"))
(printf "ok\noptimizing whole program...")
(compile-whole-program (output "wpo") (output "so") (yes? "visible-libs"))
(printf "ok\ncreating boot file...")
(make-boot-file (output "boot") boot-prereqs (output "so"))
(printf "ok\n")

(when (yes? "strip")
  (printf "stripping boot file...")
  (strip-fasl-file (output "boot") (output "boot")
    (fasl-strip-options inspector-source source-annotations profile-source
                        compile-time-information))
  (printf "ok\n"))
