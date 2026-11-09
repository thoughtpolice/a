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

;; Read and apply what arrives within timeout milliseconds; #f if nothing
;; did.
(define (pump! timeout)
  (let ([got (kernel-read-some fd timeout)])
    (and got (> (bytevector-length got) 0)
         (begin (for-each (lambda (m) (grid-model-apply! model m)) (reader got (bytevector-length got))) #t))))

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

;; A size no screen has is ignored, and the daemon goes on.
(send '("resize" "x" 1))
(send '("resize" 100000 100000))
(key! "esc")
(expect-equal "still its size" (list (grid-model-rows model) (grid-model-cols model)) '(6 30))
(send '("detach"))

;; A client whose hello is malformed is let go, and the daemon goes on.
(let ([bad (kernel-unix-connect (getenv "QUAD_SOCKET"))])
  (let ([send (frame-sender bad)])
    (send (list "hello" protocol-version "bad" 24 80 #f))
    (check "a bad hello is let go" (not (kernel-read-some bad 5000))))
  (kernel-close bad))
(let ([again (kernel-unix-connect (getenv "QUAD_SOCKET"))])
  ((frame-sender again) (list "hello" protocol-version "again" 4 20 '()))
  (check "the daemon goes on" (let ([got (kernel-read-some again 5000)]) (and got (> (bytevector-length got) 0))))
  ((frame-sender again) '("detach"))
  (kernel-close again))
