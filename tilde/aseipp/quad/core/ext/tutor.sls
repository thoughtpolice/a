;; tutor.sls -- a tutorial: the editor taught in a buffer, by using it
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; As vimtutor does for Vim: lessons that explain a few keys at a time,
;; each with lines to practise them on and what those lines should become.
;; There is one for each key scheme (keymap.sls) -- tutor.md for Ki's
;; keys, tutor-vim.md for Vim's, tutor-helix.md for Helix's -- beside this
;; file, compiled in. `space k h`, the command `tutor`, and `quad --tutor`
;; open a fresh copy of the one for the keys in use in *tutor*, a buffer
;; with no file, so nothing is written unless it is saved.
(library (quad ext tutor)
  (export tutor-text vim-tutor-text helix-tutor-text current-tutor-text tutor!)
  (import (chezscheme) (quad util) (quad buffer) (quad editor) (quad commands) (quad keymap))

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

  ;; Lessons, less the license comment at their head.
  (define (lessons s)
    (let ([end (and (string-prefix? "<!--" s) (string-contains s "-->\n\n"))])
      (if end (substring s (+ end 5) (string-length s)) s)))

  (define tutor-text (lessons (include-text "tutor.md")))
  (define vim-tutor-text (lessons (include-text "tutor-vim.md")))
  (define helix-tutor-text (lessons (include-text "tutor-helix.md")))

  ;; The lessons for the keys in use.
  (define (current-tutor-text)
    (case (let ([s (current-key-scheme)]) (and s (key-scheme-name s)))
      [(vim) vim-tutor-text]
      [(helix) helix-tutor-text]
      [else tutor-text]))

  ;; Show a fresh copy of the tutor, from its start.
  (define (tutor!)
    (let ([b (find-buffer-named "*tutor*")]
          [mode (or (find-major-mode 'markdown) fundamental-mode)])
      (if b
          (buffer-replace-all! b (current-tutor-text))
          (set! b (new-buffer! "*tutor*" (current-tutor-text) mode)))
      (switch-to-buffer! b)
      (set-selection-mode! b 'char)
      (set-primary! (make-sel 0 1))))

  (at-load
   (define-command 'tutor "Learn quad's keys: lessons to work through, in a buffer" tutor!)
   (define-key (keymap-lookup-target space-keymap "k") "h" 'tutor "Tutor")))
