;; tutor.sls -- a tutorial: the editor taught in a buffer, by using it
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; As vimtutor does for Vim: lessons that explain a few keys at a time,
;; each with lines to practise them on and what those lines should become.
;; The lessons are tutor.md, beside this file, compiled in. `space k h`,
;; the command `tutor`, and `quad --tutor` open a fresh copy in *tutor*, a
;; buffer with no file, so nothing is written unless it is saved.
(library (quad ext tutor)
  (export tutor-text tutor!)
  (import (chezscheme) (quad util) (quad buffer) (quad editor) (quad commands))

  ;; The text of the file name, beside this library's source, as a string
  ;; constant: read as the library compiles, so the executable carries it.
  (define-syntax include-text
    (lambda (x)
      (syntax-case x ()
        [(k name)
         (let* ([a (syntax->annotation #'k)]
                [dir (if a
                         (path-parent (source-file-descriptor-path (source-object-sfd (annotation-source a))))
                         ".")]
                [path (string-append dir "/" (syntax->datum #'name))])
           (datum->syntax #'k
                          (call-with-port (open-file-input-port path (file-options) 'block
                                                                (make-transcoder (utf-8-codec)))
                                          get-string-all)))])))

  ;; The lessons, less the license comment at their head.
  (define tutor-text
    (let* ([s (include-text "tutor.md")]
           [end (and (string-prefix? "<!--" s) (string-contains s "-->\n\n"))])
      (if end (substring s (+ end 5) (string-length s)) s)))

  ;; Show a fresh copy of the tutor, from its start.
  (define (tutor!)
    (let ([b (find-buffer-named "*tutor*")]
          [mode (or (find-major-mode 'markdown) fundamental-mode)])
      (if b
          (buffer-replace-all! b tutor-text)
          (set! b (new-buffer! "*tutor*" tutor-text mode)))
      (switch-to-buffer! b)
      (set-selection-mode! b 'char)
      (set-primary! (make-sel 0 1))))

  (at-load
   (define-command 'tutor "Learn quad's keys: lessons to work through, in a buffer" tutor!)
   (define-key (keymap-lookup-target space-keymap "k") "h" 'tutor "Tutor")))
