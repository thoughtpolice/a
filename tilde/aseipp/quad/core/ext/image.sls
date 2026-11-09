;; image.sls -- PNG files, shown as images
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Opening a PNG file shows it: the image mode's buffers are binary (the
;; file is not read as text, and never saved), and draw the image over
;; their text area (display.sls's pictures). A window draws it; a
;; terminal that speaks the kitty graphics protocol does too; anything
;; else shows what the image is. The file is read again when it changes
;; (focusing the editor, or space j d, notes that).
(library (quad ext image)
  (export image-mode png-size png-encode file-picture)
  (import (chezscheme) (quad util) (quad syntax) (quad buffer) (quad editor)
          (quad display) (quad native))

  (define png-signature #vu8(137 80 78 71 13 10 26 10))

  ;; A PNG's width and height, (w . h), from its header; #f if it is not
  ;; a PNG.
  (define (png-size bv)
    (and (>= (bytevector-length bv) 24)
         (let ([sig (make-bytevector 8)])
           (bytevector-copy! bv 0 sig 0 8)
           (bytevector=? sig png-signature))
         (let ([w (bytevector-u32-ref bv 16 'big)] [h (bytevector-u32-ref bv 20 'big)])
           (and (> w 0) (> h 0) (cons w h)))))

;; A PNG of width by height pixels, rgba holding them (RGBA bytes, top row
  ;; first), stored without compression: for tests, and small images.
  (define (png-encode width height rgba)
    (define crc-table
      (let ([v (make-vector 256)])
        (do ([n 0 (+ n 1)]) ((= n 256) v)
          (vector-set! v n (let loop ([c n] [k 0])
                             (if (= k 8) c
                                 (loop (if (odd? c) (logxor #xedb88320 (ash c -1)) (ash c -1)) (+ k 1))))))))
    (define (crc32 bv)
      (logxor #xffffffff
              (let loop ([i 0] [c #xffffffff])
                (if (= i (bytevector-length bv)) c
                    (loop (+ i 1) (logxor (vector-ref crc-table (logand (logxor c (bytevector-u8-ref bv i)) 255))
                                          (ash c -8)))))))
    (define (adler32 bv)
      (let loop ([i 0] [a 1] [b 0])
        (if (= i (bytevector-length bv))
            (logior (ash b 16) a)
            (let ([a (modulo (+ a (bytevector-u8-ref bv i)) 65521)])
              (loop (+ i 1) a (modulo (+ b a) 65521))))))
    (define (u32 n) (let ([bv (make-bytevector 4)]) (bytevector-u32-set! bv 0 n 'big) bv))
    (define (chunk type data)
      (let ([td (bytevector-append (string->utf8 type) data)])
        (bytevector-append (u32 (bytevector-length data)) td (u32 (crc32 td)))))
    (let* ([raw (let-values ([(out extract) (open-bytevector-output-port)])
                  (do ([y 0 (+ y 1)]) ((= y height) (extract))
                    (put-u8 out 0)
                    (put-bytevector out rgba (* y width 4) (* width 4))))]
           [n (bytevector-length raw)]
           ;; zlib: stored deflate blocks of at most 65535 bytes.
           [z (let-values ([(out extract) (open-bytevector-output-port)])
                (put-u8 out #x78) (put-u8 out #x01)
                (let loop ([i 0])
                  (let* ([len (min 65535 (- n i))] [last? (= (+ i len) n)])
                    (put-u8 out (if last? 1 0))
                    (put-u8 out (logand len 255)) (put-u8 out (ash len -8))
                    (put-u8 out (logand (lognot len) 255)) (put-u8 out (logand (ash (lognot len) -8) 255))
                    (put-bytevector out raw i len)
                    (unless last? (loop (+ i len)))))
                (put-bytevector out (u32 (adler32 raw)))
                (extract))]
           [ihdr (bytevector-append (u32 width) (u32 height) #vu8(8 6 0 0 0))])
      (bytevector-append png-signature (chunk "IHDR" ihdr) (chunk "IDAT" z) (chunk "IEND" #vu8()))))

  ;; Files' pictures, read again when the file's time changes: path ->
  ;; (time . picture), or (time . why) for a file that is not a PNG.
  (define read-pictures (make-hashtable string-hash string=?))

  ;; The picture of the PNG file at path, as of time mtime; or a string,
  ;; why there is none.
  (define (file-picture path mtime)
    (let ([known (hashtable-ref read-pictures path #f)])
      (if (and known (equal? (car known) mtime))
          (cdr known)
          (let ([p (guard (e [#t (format "~a cannot be read" (path-basename path))])
                     (let* ([png (call-with-port (open-file-input-port path) get-bytevector-all)]
                            [png (if (eof-object? png) (make-bytevector 0) png)]
                            [size (png-size png)])
                       (if size
                           (make-picture (bytevector->hex (blake3 png)) (car size) (cdr size) png)
                           (format "~a is not a PNG image" (path-basename path)))))])
            (hashtable-set! read-pictures path (cons mtime p))
            p))))

  ;; Write s centered on row r of g's width columns.
  (define (put-centered! g r width s face)
    (put-string! g r (max 0 (quotient (- width (string-width s)) 2)) s face))

  ;; The image over the text area, for a client that draws images; else
  ;; what it is, in words.
  (define (draw-image! g v row0 height width)
    (let* ([b (view-buffer v)]
           [p (if (buffer-path b) (file-picture (buffer-path b) (buffer-local b 'mtime #f)) "No file")]
           [middle (+ row0 (quotient height 2))])
      (cond
       [(string? p) (put-centered! g middle width p (ui-face 'ui.message.error))]
       [(client-has? (current-client) "images") (place-picture! g p row0 0 height width)]
       [else
        (put-centered! g middle width
                       (format "PNG image, ~a × ~a" (picture-width p) (picture-height p))
                       (ui-face 'ui.text))
        (put-centered! g (+ middle 1) width "(this terminal does not show images)"
                       (ui-face 'ui.text.dim))])))

  (define image-mode (define-major-mode! 'image plain-syntax))

  (at-load
   (set-binary-mode! 'image)
   (add-auto-mode! '("png" "PNG") 'image)
   (define-buffer-drawer! 'image draw-image!)))
