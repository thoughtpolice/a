;; themes.ss -- themes, and colors as each kind of terminal gets them
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 20 80)

;; WCAG's contrast ratio of two colors.
(define (luminance c)
  (let ([lin (lambda (x) (let ([x (/ x 255.0)]) (if (<= x 0.03928) (/ x 12.92) (expt (/ (+ x 0.055) 1.055) 2.4))))]
        [c (color-rgb c)])
    (+ (* 0.2126 (lin (color-red c))) (* 0.7152 (lin (color-green c))) (* 0.0722 (lin (color-blue c))))))
(define (contrast a b)
  (let ([la (luminance a)] [lb (luminance b)]) (/ (+ (max la lb) 0.05) (+ (min la lb) 0.05))))

(define palette-themes
  '(gruvbox-dark gruvbox-light solarized-dark solarized-light dracula nord catppuccin-mocha
    catppuccin-latte tokyo-night one-dark everforest-dark rose-pine kanagawa))
(check "a dozen and more" (for-all (lambda (t) (memq t (theme-names))) (cons* 'terminal 'quad-default palette-themes)))

;; Each loads, through the variable, and its text reads against its
;; background (4:1 at least: Solarized's light body text is 4.1:1, as its
;; author made it, where WCAG asks 4.5); comments less so, but still; a
;; selection stands apart from the rest.
(for-each
 (lambda (t)
   (set-var! 'theme t)
   (let ([fg (face-fg (face-ref 'ui.text))] [bg (face-bg (face-ref 'ui.background))])
     (check (format "~a: loaded" t) (eq? (current-theme-name) t))
     (check (format "~a: text reads (~,1f)" t (contrast fg bg)) (>= (contrast fg bg) 4.0))
     (check (format "~a: comments read" t) (>= (contrast (face-fg (face-ref 'comment)) bg) 2.0))
     (check (format "~a: a selection shows" t) (not (= (face-bg (face-ref 'ui.selection)) bg)))
     (check (format "~a: keywords and strings differ" t)
            (not (= (face-fg (face-ref 'keyword)) (face-fg (face-ref 'string)))))
     (check (format "~a: says dark or light" t) (memq (theme-kind t) '(dark light)))
     (redraw!)))
 palette-themes)

;; The terminal's own colors: none for the text, its palette for the rest.
(set-var! 'theme 'terminal)
(check "terminal: the terminal's text colors" (not (face-fg (face-ref 'ui.text))))
(expect-equal "terminal: its red" (face-fg (face-ref 'ui.message.error)) (indexed-color 1))
(expect-equal "a window draws it as Tomorrow Night has it" (color-rgb (indexed-color 1)) #xcc6666)
(expect-equal "and the rest as xterm does" (color-rgb (indexed-color 196)) #xff0000)

;; The picker shows each theme as it is selected, and cancelling goes back.
(set-var! 'theme 'nord)
(press! "space" "k" "t")
(check "the picker starts at the theme in use" (eq? (current-theme-name) 'nord))
(press! "down")
(check "the next one shows" (not (eq? (current-theme-name) 'nord)))
(press! "esc")
(check "cancelled: back" (eq? (current-theme-name) 'nord))
(press! "space" "k" "t" "down")
(let ([picked (current-theme-name)])
  (press! "enter")
  (check "picked" (and (eq? (current-theme-name) picked) (eq? (get-var 'theme) picked))))

;; Colors as each kind of terminal gets them.
(expect-equal "24-bit" (hl-sgr #xff8000 #f 0 'truecolor) "\x1b;[0;38;2;255;128;0m")
(expect-equal "256: the nearest" (hl-sgr #xff0000 #x000000 0 256) "\x1b;[0;38;5;196;48;5;16m")
(expect-equal "16: the nearest" (hl-sgr #xff0000 #x0000ee 0 16) "\x1b;[0;91;44m")
(expect-equal "the palette's 16, anywhere" (hl-sgr (indexed-color 2) (indexed-color 8) 0 'truecolor) "\x1b;[0;32;100m")
(expect-equal "the palette beyond 16" (hl-sgr (indexed-color 208) #f 0 'truecolor) "\x1b;[0;38;5;208m")
(expect-equal "a gray" (nearest-256 #x808080) 244)

;; How many colors a terminal has.
(define (depth env kitty?)
  (for-each (lambda (v) (putenv v "")) '("QUAD_COLORS" "COLORTERM" "TERM" "TERM_PROGRAM" "VTE_VERSION"))
  (for-each (lambda (p) (putenv (car p) (cdr p))) env)
  (color-depth kitty?))
(expect-equal "COLORTERM" (depth '(("COLORTERM" . "truecolor") ("TERM" . "xterm-256color")) #f) 'truecolor)
(expect-equal "the kitty protocol" (depth '(("TERM" . "xterm-256color")) #t) 'truecolor)
(expect-equal "ghostty by name" (depth '(("TERM" . "xterm-ghostty")) #f) 'truecolor)
(expect-equal "256" (depth '(("TERM" . "tmux-256color")) #f) 256)
(expect-equal "the console" (depth '(("TERM" . "linux")) #f) 16)
(expect-equal "QUAD_COLORS says" (depth '(("QUAD_COLORS" . "256") ("COLORTERM" . "truecolor")) #t) 256)
