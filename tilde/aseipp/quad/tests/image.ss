;; image.ss -- PNG files shown as images: to clients that draw them, in
;; words to others
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 14 50)

;; A w by h PNG of one color.
(define (solid-png w h r g b)
  (let ([px (make-bytevector (* w h 4))])
    (do ([i 0 (+ i 4)]) ((= i (bytevector-length px)))
      (bytevector-u8-set! px i r) (bytevector-u8-set! px (+ i 1) g)
      (bytevector-u8-set! px (+ i 2) b) (bytevector-u8-set! px (+ i 3) 255))
    (png-encode w h px)))

(define dir (let ([t (current-time)]) (format "/tmp/quad-image-test-~a-~a" (time-second t) (time-nanosecond t))))
(mkdir dir)
(define png-path (string-append dir "/red.png"))
(define png (solid-png 30 20 255 0 0))
(call-with-port (open-file-output-port png-path) (lambda (p) (put-bytevector p png)))

(expect-equal "a PNG's size, from its header" (png-size png) '(30 . 20))
(expect-equal "and not a PNG" (png-size (string->utf8 "hello, this is plain text")) #f)

;; ---------------------------------------------------------------------------
;; The buffer

(define b (open-file! png-path))
(expect-equal "a PNG opens in the image mode" (major-mode-name (buffer-major-mode b)) 'image)
(expect-equal "its bytes are not read as text" (buffer-string b) "")
(expect-equal "it is read-only" (buffer-read-only? b) #t)
(expect-equal "and never saved over the file"
              (guard (e [#t 'refused]) (save-buffer! b) 'saved)
              'refused)
(expect-equal "the file is as it was" (call-with-port (open-file-input-port png-path) get-bytevector-all) png)

;; ---------------------------------------------------------------------------
;; A client that draws images

(define (client-with capabilities)
  (let* ([model (make-grid-model)] [msgs '()]
         [c (server-connect! "test" 14 50 capabilities
                             (lambda (m) (set! msgs (cons m msgs)) (grid-model-apply! model m))
                             void)])
    (with-client c (lambda () (switch-to-buffer! b)))
    (list c model (lambda () (reverse msgs)) (lambda () (set! msgs '())))))
(define drawer (client-with '("images")))
(redraw!)

(define (sent cl kind) (filter (lambda (m) (equal? (car m) kind)) ((caddr cl))))
(define key (picture-key (file-picture png-path (buffer-local b 'mtime #f))))
(expect-equal "the image is sent" (map (lambda (m) (list-head m 4)) (sent drawer "image")) (list (list "image" key 30 20)))
(expect-equal "as the file's bytes" (list-ref (car (sent drawer "image")) 4) png)
;; Rows 1 to 11 are the text area (row 0 has the buffers, 12 the status
;; line), all 50 columns.
(expect-equal "and placed over the text area" (grid-model-images (cadr drawer)) (list (list key 1 0 11 50 11)))

((cadddr drawer))
(redraw!)
(expect-equal "an unchanged frame sends nothing" ((caddr drawer)) '())

;; Something drawn over the image's cells hides those rows: the
;; command palette opens over the bottom of the text area.
(with-client (car drawer) (lambda () (run-command 'command-palette)))
(redraw!)
(let ([placed (grid-model-images (cadr drawer))])
  (expect-equal "what is drawn over it is not hidden by it"
                (and (pair? placed) (< (list-ref (car placed) 5) 11))
                #t))
(expect-equal "the image is not sent again" (sent drawer "image") '())
(with-client (car drawer) (lambda () (run-command 'prompt-cancel)))
(redraw!)
(expect-equal "it shows whole again" (grid-model-images (cadr drawer)) (list (list key 1 0 11 50 11)))

(with-client (car drawer) (lambda () (switch-to-buffer! (find-buffer-named "*scratch*"))))
(redraw!)
(expect-equal "another buffer places nothing" (grid-model-images (cadr drawer)) '())
(with-client (car drawer) (lambda () (switch-to-buffer! b)))
((cadddr drawer))
(redraw!)
(expect-equal "back on it, it is placed but not sent again"
              (list (sent drawer "image") (grid-model-images (cadr drawer)))
              (list '() (list (list key 1 0 11 50 11))))

;; The file changes: it is read again, as a new image.
(define blue (solid-png 10 40 0 0 255))
(call-with-port (open-file-output-port png-path (file-options no-fail)) (lambda (p) (put-bytevector p blue)))
(buffer-local-set! b 'mtime 'changed)
((cadddr drawer))
(redraw!)
(expect-equal "a changed file is sent anew" (map (lambda (m) (list-ref m 3)) (sent drawer "image")) '(40))

;; ---------------------------------------------------------------------------
;; A client that does not

(define words (client-with '()))
(redraw!)
(expect-equal "a client that draws no images is told none" (sent words "images") '())
(expect-equal "it is told what the image is, in words"
              (and (exists (lambda (l) (string-contains l "PNG image, 10 × 40")) (grid-model-lines (cadr words))) #t)
              #t)

(delete-file png-path)
(delete-directory dir)
