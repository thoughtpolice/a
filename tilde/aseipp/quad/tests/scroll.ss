;; scroll.ss -- scroll hints: a client that moves its rows itself sees
;; what one sent every line sees
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 14 40)
(define buf (headless-buffer! (apply string-append (map (lambda (i) (format "line ~a of the file\n" i)) (iota 200)))
                              'text))

;; Two more clients on the buffer, counting the lines they are sent: one
;; that takes scroll hints, one that does not.
(define (client-with capabilities)
  (let* ([model (make-grid-model)] [lines 0]
         [c (server-connect! "test" 14 40 capabilities
                             (lambda (m)
                               (when (equal? (car m) "line") (set! lines (+ lines 1)))
                               (grid-model-apply! model m))
                             void)])
    (with-client c (lambda () (switch-to-buffer! buf)))
    (list c model (lambda () lines))))
(define hinted (client-with '("scroll")))
(define plain (client-with '()))
(redraw!)

(define (on-both thunk)
  (for-each (lambda (cl) (with-client (car cl) thunk)) (list hinted plain))
  (redraw!))
;; Each shows the other's name (its cursor, the status line): call it
;; "other" in both.
(define (replace-all s from to)
  (let ([n (string-length from)])
    (let loop ([i 0] [acc '()])
      (cond
       [(> (+ i n) (string-length s)) (apply string-append (reverse (cons (substring s i (string-length s)) acc)))]
       [(string=? (substring s i (+ i n)) from) (loop (+ i n) (cons to acc))]
       [else (loop (+ i 1) (cons (string (string-ref s i)) acc))]))))
(define (screen-of cl other)
  (map (lambda (l) (replace-all l (client-user (car other)) "other")) (grid-model-lines (cadr cl))))
(define (same-screens? name)
  (expect-equal name (screen-of hinted plain) (screen-of plain hinted)))

;; Each step: its name, whether it stays within a screen (so that rows
;; can move), and what it does.
(define near 0) (define near-plain 0)
(for-each
 (lambda (step)
   (let ([h ((caddr hinted))] [p ((caddr plain))])
     (on-both (caddr step))
     (same-screens? (car step))
     (let ([h (- ((caddr hinted)) h)] [p (- ((caddr plain)) p)])
       (if (cadr step)
           (begin (set! near (+ near h)) (set! near-plain (+ near-plain p)))
           (check (string-append (car step) ": no more lines than without hints") (<= h p))))))
 (list (list "a page down" #t (lambda () (run-command 'scroll-down)))
       (list "another" #t (lambda () (run-command 'scroll-down)))
       (list "back up" #t (lambda () (run-command 'scroll-up)))
       (list "the wheel, down" #t (lambda () (client-receive! (current-client) '("mouse" "scroll-down" 0 5 5 0))))
       (list "and up" #t (lambda () (client-receive! (current-client) '("mouse" "scroll-up" 0 5 5 0))))
       (list "far down, past a screen" #f (lambda () (run-command (lambda () (goto-line! 150)))))
       (list "and back" #f (lambda () (run-command (lambda () (goto-line! 100)))))))
(check "scrolling within a screen, a client taking hints is sent fewer than half the lines"
       (< near (/ near-plain 2)))
