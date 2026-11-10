;; test-standalone.ss -- run the standalone demo executable
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --script test-standalone.ss EXE MANIFEST
;;
;; EXE runs, from where it was built and, found through PATH, from elsewhere,
;; where its argv[0] names no file: it finds its boot files by asking the
;; system where it is. MANIFEST, (demo greet)'s, has each library after what
;; it imports. Processes run through the system's shell: sh, or cmd.exe on
;; Windows.
(import (chezscheme))

(reset-handler (lambda () (exit 1)))

(define-values (exe manifest) (apply values (command-line-arguments)))

(define windows? (char=? (directory-separator) #\\))

;; A path as the shell takes it: cmd.exe reads a / as an option's start.
;; Buck2's paths have no spaces, so they go unquoted.
(define (native path)
  (list->string
   (map (lambda (c) (if (char=? c #\/) (directory-separator) c))
        (string->list path))))

(define (trim s)
  (let loop ([n (string-length s)])
    (if (and (> n 0) (char-whitespace? (string-ref s (- n 1))))
        (loop (- n 1))
        (substring s 0 n))))

(define (run command)
  (let-values ([(to from err pid)
                (open-process-ports (format "~a 2>&1" command) (buffer-mode block) (native-transcoder))])
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

(define expected "HELLO, CHEZ HELLO, CHEZ (\"a\" \"b\")")

(check "run" (run (format "~a a b" (native exe))) expected)

(let* ([abs (native (if (path-absolute? exe) exe (format "~a/~a" (current-directory) exe)))]
       [dir (path-parent abs)]
       [name (path-last abs)])
  (putenv "PATH" (format "~a~a~a" dir (if windows? ";" ":") (or (getenv "PATH") "")))
  (parameterize ([current-directory (if windows? "\\" "/")])
    (check "run through PATH" (run (format "~a a b" name)) expected)))

(check "manifest"
       (call-with-input-file manifest read)
       '(((demo greet name) "demo/greet/name.so") ((demo greet) "demo/greet.so")))

(exit (if (= failures 0) 0 1))
