;; grep.sls -- searching a directory's files as you type
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; space k g searches the working directory's files for a regular
;; expression (Rust's regex syntax; smart case: no capitals, no case),
;; as you type, and picks among the lines that match. The files are the
;; project's: those its ignore files do not ignore (kernel/files/), and
;; the search runs on threads of the kernel's, its hits arriving as they
;; are found, at most ten thousand of them.
(library (quad ext grep)
  (export grep-picker!)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad editor) (quad commands)
          (quad server) (only (quad native) grep-start grep-fd grep-take!))

  ;; Search the files under dir as you type (a regular expression, smart
  ;; case), in a picker of the lines that match: what each search finds
  ;; arrives as it is found, and a new one starts as the pattern changes.
  (define (grep-picker! dir)
    (let ([c (current-client)] [p #f] [search #f] [src #f] [pattern #f] [hits '()] [note #f])
      (define (stop!)
        (when src (remove-source! src) (set! src #f))
        (set! search #f))
      (define (start! pat)
        (stop!)
        (set! pattern pat)
        (set! hits '())
        (set! note #f)
        (unless (string=? pat "")
          (guard (e [#t (set! note (string-append "Not a pattern yet: " (condition->string e)))])
            (set! search (grep-start dir pat #t (not (exists char-upper-case? (string->list pat)))))
            (let ([g search])
              (set! src (watch-fd! (grep-fd g)
                                   (lambda ()
                                     (cond
                                      ;; Closed, or another search started.
                                      [(not (and (memq c (clients)) (eq? search g)
                                                 (with-client c (lambda () (eq? (current-prompt) p)))))
                                       (stop!)]
                                      [else
                                       (for-each
                                        (lambda (f)
                                          (if (equal? (car f) "hit")
                                              (set! hits (cons (cdr f) hits))
                                              (begin
                                                (set! note (cond [(caddr f) (format "The first ~a matches" (cadr f))]
                                                                 [(= 0 (cadr f)) "No match"]
                                                                 [else #f]))
                                                (when src (remove-source! src) (set! src #f)))))
                                        (grep-take! g))
                                       (with-client c (lambda () (prompt-refresh! p)))]))))))))
      (define (candidates input)
        (unless (equal? input pattern) (start! input))
        (append
         (if note (list (cons note #f)) '())
         (map (lambda (h)
                (cons (format "~a:~a: ~a" (car h) (+ 1 (cadr h)) (string-trim (cadddr h)))
                      (list (path-join dir (car h)) (cadr h) (caddr h))))
              (reverse hits))))
      (set! p (make-prompt (format "Grep ~a" (path-basename (string-trim-right dir))) "" (unfiltered candidates)
                           (lambda (hit)
                             (stop!)
                             (when (pair? hit)
                               (let* ([b (switch-to-buffer! (open-file! (car hit)))] [t (buffer-text b)]
                                      [s (text-pos-at t (cadr hit) (caddr hit))])
                                 (set-sels! b (list (make-sel s s))))))
                           #f 'picker))
      (open-prompt! p)))

  (at-load
   (define-command 'grep "Search the working directory's files, as you type"
     (lambda () (grep-picker! (current-directory))))
   (define-key (keymap-lookup-target space-keymap "k") "g" 'grep "Grep")))
