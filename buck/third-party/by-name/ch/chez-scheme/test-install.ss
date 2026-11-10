;; test-install.ss -- the installed tools, run as a user would run them
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --script test-install.ss VERSION MACHINE SCHEME PETITE SCRIPT SUM
;;
;; The version, the machine type and its threads, the compiler (which petite
;; lacks), and a script (SUM, run by scheme-script). Each tool runs in a
;; process of its own, through the system's shell: sh, or cmd.exe on
;; Windows.
(import (chezscheme))

(reset-handler (lambda () (exit 1)))

(define-values (version machine scheme petite script sum)
  (apply values (command-line-arguments)))

;; A path as the shell takes it: cmd.exe reads a / as an option's start.
;; The paths are Buck2's, relative ones with no spaces, so they go unquoted:
;; cmd.exe /c would strip the first and last of several quotes.
(define (native path)
  (list->string
   (map (lambda (c) (if (char=? c #\/) (directory-separator) c))
        (string->list path))))

(define (trim s)
  (let loop ([n (string-length s)])
    (if (and (> n 0) (char-whitespace? (string-ref s (- n 1))))
        (loop (- n 1))
        (substring s 0 n))))

;; Run `tool` with `args` (a string), `input` on its standard input; what it
;; wrote to its standard output and error, trailing whitespace removed.
(define (run tool args input)
  (let-values ([(to from err pid)
                (open-process-ports
                 (format "~a ~a 2>&1" (native tool) args)
                 (buffer-mode block)
                 (native-transcoder))])
    (put-string to input)
    (close-port to)
    (let ([out (get-string-all from)])
      (close-port from)
      (close-port err)
      (trim (if (eof-object? out) "" out)))))

(define failures 0)

(define (check what got expected)
  (unless (equal? got expected)
    (set! failures (+ failures 1))
    (printf "FAIL ~a: got ~s, expected ~s~n" what got expected)))

(check "version" (run scheme "--version" "") version)
(check "machine type" (run scheme "-q" "(machine-type)\n") machine)
(check "threads" (run scheme "-q" "(threaded?)\n") "#t")
(check "petite" (run petite "-q" "(petite?)\n") "#t")
(check "compile" (run scheme "-q" "(compile '(+ 1 2))\n") "3")
(check "script" (run script (format "~a 1 2 3" (native sum)) "") "6")

(exit (if (= failures 0) 0 1))
