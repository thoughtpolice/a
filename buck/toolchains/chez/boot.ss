;; boot.ss -- make a boot file from compiled libraries and programs
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --script boot.ss out=FILE requires=scheme,petite
;;          lib=OBJDIR:MANIFEST ... [program=OBJ ...] [strip=yes]
;;
;; lib= arguments come dependencies first; each manifest lists its
;; directory's libraries in load order. A library appears once, at its first
;; mention. Programs load last, in order: they run as the boot file loads.
(import (chezscheme))

(define args
  (map (lambda (a)
         (let ([i (let loop ([i 0]) (if (char=? (string-ref a i) #\=) i (loop (+ i 1))))])
           (cons (string->symbol (substring a 0 i)) (substring a (+ i 1) (string-length a)))))
       (command-line-arguments)))
(define (arg k) (let ([p (assq k args)]) (and p (cdr p))))
(define (args-of k) (map cdr (filter (lambda (p) (eq? (car p) k)) args)))

(define (split s ch)
  (let loop ([i 0] [start 0] [acc '()])
    (cond
     [(= i (string-length s)) (reverse (if (> i start) (cons (substring s start i) acc) acc))]
     [(char=? (string-ref s i) ch) (loop (+ i 1) (+ i 1) (if (> i start) (cons (substring s start i) acc) acc))]
     [else (loop (+ i 1) start acc)])))

(reset-handler (lambda () (exit 1)))

(define objects
  (let loop ([libs (args-of 'lib)] [seen '()] [acc '()])
    (if (null? libs)
        (reverse acc)
        (let* ([parts (split (car libs) #\:)]
               [dir (car parts)]
               [manifest (call-with-input-file (cadr parts) read)]
               [fresh (filter (lambda (e) (not (member (car e) seen))) manifest)])
          (loop (cdr libs)
                (append (map car fresh) seen)
                (append (reverse (map (lambda (e) (string-append dir "/" (cadr e))) fresh)) acc))))))

(apply make-boot-file (arg 'out) (split (or (arg 'requires) "") #\,)
       (append objects (args-of 'program)))

;; Stripping keeps compile-time information: without it the libraries'
;; exports are gone, and nothing could import them at run time.
(when (equal? (arg 'strip) "yes")
  (strip-fasl-file (arg 'out) (arg 'out)
                   (fasl-strip-options inspector-source source-annotations profile-source)))
