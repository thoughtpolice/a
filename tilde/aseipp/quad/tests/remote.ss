;; remote.ss -- a client over a socket, against `quad --daemon`
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Speaks the protocol as any out-of-process client would: frames over the
;; daemon's Unix socket ($QUAD_SOCKET), a model of the screen from them.

(define fd (kernel-unix-connect (getenv "QUAD_SOCKET")))
(check "connected" (>= fd 0))
(define send (frame-sender fd))
(define reader (make-frame-reader))
(define model (make-grid-model))
(define buf (make-bytevector 65536))

;; Read and apply what arrives within timeout milliseconds; #f if nothing
;; did.
(define (pump! timeout)
  (let ([n (kernel-read fd buf (bytevector-length buf) timeout)])
    (and (> n 0)
         (begin (for-each (lambda (m) (grid-model-apply! model m)) (reader buf n)) #t))))

;; Read until (pred), or fail: the server sends frames only when something
;; changed, so a test waits for what it expects.
(define (await! what pred)
  (let loop ()
    (unless (pred)
      (unless (pump! 5000) (errorf 'remote "no ~a from the server" what))
      (loop))))

;; Send a key, and take in whatever it changes.
(define (key! spec)
  (send (event->message (spec->key-event spec)))
  (let loop () (when (pump! 200) (loop))))
(define (rows) (grid-model-lines model))

(send (list "hello" protocol-version "remote-test" 8 50 '("clipboard")))
(await! "frame" (lambda () (> (grid-model-frames model) 0)))
(expect-equal "size" (list (grid-model-rows model) (grid-model-cols model)) '(8 50))
(check "the daemon's file" (exists (lambda (r) (string-contains r "remote content")) (rows)))

(key! "s")
(key! "l")
(key! "c")
(key! "c")
(expect-equal "copy reached our clipboard"
              (find (lambda (m) (equal? (car m) "clipboard-set")) (grid-model-other model))
              '("clipboard-set" "c" "content"))

;; Resizing redraws at the new size.
(send '("resize" 6 30))
(key! "esc")
(expect-equal "resized" (list (grid-model-rows model) (grid-model-cols model)) '(6 30))

;; Evaluation, as this client.
(send '("eval" 7 "(buffer-name (current-buffer))"))
(define (result) (find (lambda (m) (equal? (car m) "result")) (grid-model-other model)))
(await! "result" result)
(expect-equal "eval" (result) '("result" 7 #t "\"file.txt\""))
(send '("detach"))
