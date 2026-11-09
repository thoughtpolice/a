;; init.ss -- an example init file: copy to ~/.config/quad/init.ss
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Everything quad exports is in scope here, and definitions become part of
;; the running editor.

;; Variables.
(set-var! 'line-numbers 'relative)
(set-var! 'scroll-margin 5)
(set-var! 'legend-delay 200)

;; A command, with a key in normal mode and an entry in the space menu.
(define-command 'shout "Upcase the selections"
  (lambda ()
    (edit-sels!
     (lambda (s)
       (let ([t (string-upcase (selection-text (current-buffer) s))])
         (list (sel-range-start s) (sel-range-end s) t
               (lambda (p) (make-sel p (+ p (string-length t))))))))))

(define-key normal-keymap "ctrl+u" 'shout "Shout")
(define-key (keymap-lookup-target space-keymap "l") "u" 'shout "Shout")

;; A status line segment, given the view drawn: the number of lines.
(define-status-segment! 'right
  (lambda (v)
    (cons (format "~a lines  " (text-line-count (buffer-text (view-buffer v)))) 'ui.statusline.dim)))

;; Strip trailing whitespace before saving.
(add-hook! 'before-save-hook
           (lambda (b)
             (let ([s (buffer-string b)])
               (let ([clean (string-join (map string-trim-right (string-split s #\newline)) "\n")])
                 (unless (string=? s clean)
                   (let ([sels (sels-of b)])
                     (buffer-replace-all! b clean)
                     (set-sels! b sels)))))))

;; A theme of your own: a palette, then faces over it.
(define-theme 'quad-dusk
  '((bg . "#1e1b2e") (fg . "#cdd6f4") (accent . "#f5c2e7") (dim . "#6c7086") (sel . "#45475a"))
  '((ui . ((fg fg) (bg bg)))
    (ui.text . fg)
    (ui.linenr . dim)
    (ui.selection . ((bg sel)))
    (ui.cursor.primary . ((fg bg) (bg accent)))
    (ui.statusline . ((fg fg) (bg "#181825")))
    (ui.statusline.normal . ((fg bg) (bg accent) bold))
    (keyword . accent)
    (comment . ((fg dim) italic))))
;; (load-theme! 'quad-dusk)
