;; themes.sls -- color themes: a dozen well-known ones, and a way to make more
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A theme here is a palette of roles -- backgrounds, foregrounds, eight
;; accents -- that define-palette-theme turns into every face quad has
;; (the same ones face.sls's quad-default sets by hand), so a new theme is
;; its colors and little else:
;;
;;   (define-palette-theme 'mine 'dark
;;     '((bg . "#1d1f21") (fg . "#c5c8c6") (red . "#cc6666") ...)
;;     '((keyword . red)))               ; faces to make otherwise
;;   (set-var! 'theme 'mine)
;;
;; The roles: bg, the text's background; bg-dark, the status line's,
;; popups' and menus'; bg-light, the cursor's line; selection; bg-alt,
;; other selections and borders; fg, the text; fg-bright, the primary
;; cursor and what is in focus; fg-dim, line numbers and what is not
;; text; comment; and red, orange, yellow, green, cyan, blue, purple and
;; pink. Any left out are made from the others.
;;
;; The palettes are their authors' (all MIT-licensed): Gruvbox (Pavel
;; Pertsev), Solarized (Ethan Schoonover), Dracula (Zeno Rocha), Nord
;; (Arctic Ice Studio), Catppuccin, Tokyo Night (enkia, Folke Lemaitre),
;; One Dark (GitHub's Atom), Everforest (sainnhe), Rosé Pine, Kanagawa
;; (Tommaso Laurenzi). `terminal` is the terminal's own: its palette of 16
;; and its default colors, so that quad looks as the terminal is set up.
(library (quad ext themes)
  (export define-palette-theme theme-kind)
  (import (chezscheme) (quad util) (quad face) (quad color))

  (define kinds (make-eq-hashtable))

  ;; Whether theme name is 'dark or 'light, if it says.
  (define (theme-kind name) (hashtable-ref kinds name #f))

  (define (hex c) (if (string? c) (string->number (substring c 1 (string-length c)) 16) c))

  ;; Make theme name, of kind 'dark or 'light, from palette (an alist of
  ;; roles to "#rrggbb" colors), with overrides (an alist of face names to
  ;; specs whose colors may name roles) made last.
  (define define-palette-theme
    (case-lambda
     [(name kind palette) (define-palette-theme name kind palette '())]
     [(name kind palette overrides)
      (let* ([given (map (lambda (p) (cons (car p) (hex (cdr p)))) palette)]
             [get (lambda (k) (let ([p (assq k given)]) (and p (cdr p))))]
             [bg (or (get 'bg) (if (eq? kind 'light) #xffffff #x1c1c1c))]
             [fg (or (get 'fg) (if (eq? kind 'light) #x1c1c1c #xd0d0d0))]
             [mix (lambda (a t) (blend-colors a bg t))]
             [role (lambda (k default) (or (get k) default))]
             [red (role 'red #xcc6666)] [green (role 'green #x98c379)] [yellow (role 'yellow #xe5c07b)]
             [blue (role 'blue #x61afef)] [purple (role 'purple #xc678dd)] [cyan (role 'cyan #x56b6c2)]
             [orange (role 'orange yellow)] [pink (role 'pink purple)]
             [roles
              (list (cons 'bg bg) (cons 'fg fg)
                    (cons 'bg-dark (role 'bg-dark (blend-colors bg (if (eq? kind 'light) #x000000 #x000000) 0.15)))
                    (cons 'bg-light (role 'bg-light (blend-colors bg fg 0.07)))
                    (cons 'selection (role 'selection (blend-colors bg fg 0.2)))
                    (cons 'bg-alt (role 'bg-alt (blend-colors bg fg 0.12)))
                    (cons 'fg-bright (role 'fg-bright (blend-colors fg (if (eq? kind 'light) #x000000 #xffffff) 0.4)))
                    (cons 'fg-dim (role 'fg-dim (blend-colors fg bg 0.55)))
                    (cons 'comment (role 'comment (blend-colors fg bg 0.4)))
                    (cons 'red red) (cons 'orange orange) (cons 'yellow yellow) (cons 'green green)
                    (cons 'cyan cyan) (cons 'blue blue) (cons 'purple purple) (cons 'pink pink)
                    ;; People's colors, and dark tints of them for their
                    ;; selections.
                    (cons 'red-tint (mix red 0.72)) (cons 'green-tint (mix green 0.72))
                    (cons 'yellow-tint (mix yellow 0.72)) (cons 'cyan-tint (mix cyan 0.72))
                    (cons 'pink-tint (mix pink 0.72)) (cons 'purple-tint (mix purple 0.72)))])
        (hashtable-set! kinds name kind)
        (define-theme name roles (append (faces-for roles) overrides)))]))

  ;; Every face, from the roles.
  (define (faces-for roles)
    (append
     '((ui . ((fg fg) (bg bg)))
       (ui.background . ((bg bg)))
       (ui.text . fg)
       (ui.text.focus . fg-bright)
       (ui.text.dim . fg-dim)
       (ui.linenr . fg-dim)
       (ui.linenr.selected . fg)
       (ui.cursorline . ((bg bg-light)))
       (ui.selection . ((bg selection)))
       (ui.selection.secondary . ((bg bg-alt)))
       (ui.cursor . ((fg bg) (bg fg-dim)))
       (ui.cursor.primary . ((fg bg) (bg fg-bright)))
       (ui.cursor.match . ((bg bg-alt) bold))
       (ui.cursor.other . ((fg bg) (bg yellow)))
       (ui.statusline . ((fg fg) (bg bg-dark)))
       (ui.statusline.inactive . ((fg fg-dim) (bg bg-dark)))
       (ui.statusline.normal . ((fg bg) (bg blue) bold))
       (ui.statusline.insert . ((fg bg) (bg green) bold))
       (ui.statusline.extend . ((fg bg) (bg yellow) bold))
       (ui.statusline.selection-mode . ((fg fg) (bg bg-alt)))
       (ui.statusline.dim . ((fg fg-dim) (bg bg-dark)))
       (ui.window . fg-dim)
       (ui.popup . ((fg fg) (bg bg-dark)))
       (ui.popup.border . ((fg fg-dim) (bg bg-dark)))
       (ui.popup.title . ((fg blue) (bg bg-dark) bold))
       (ui.popup.key . ((fg yellow) (bg bg-dark) bold))
       (ui.popup.info . ((fg fg) (bg bg-dark)))
       (ui.menu . ((fg fg) (bg bg-dark)))
       (ui.menu.selected . ((fg bg) (bg blue)))
       (ui.menu.match . ((fg yellow) bold))
       (ui.prompt . ((fg fg) (bg bg)))
       (ui.prompt.label . ((fg blue) bold))
       (ui.jump-label . ((fg bg) (bg pink) bold))
       (ui.message . fg)
       (ui.message.error . red)
       (ui.message.warning . yellow)
       (ui.virtual . fg-dim)
       (ui.virtual.whitespace . bg-alt)
       (ui.link . ())
       (ui.link.hover . (underline))
       (ui.gutter.blame . fg-dim)
       (diff.plus . green)
       (diff.minus . red)
       (diff.delta . blue)
       (comment . ((fg comment) italic))
       (keyword . purple)
       (keyword.special . ((fg pink) bold))
       (function . blue)
       (string . green)
       (constant . orange)
       (constant.numeric . orange)
       (constant.character . yellow)
       (constant.builtin . cyan)
       (punctuation . fg)
       (punctuation.bracket . fg)
       (operator . cyan)
       (type . yellow)
       (variable . fg)
       (special . orange)
       (markup.heading . ((fg blue) bold))
       (markup.bold . ((fg fg) bold))
       (markup.italic . ((fg fg) italic))
       (markup.link . ((fg cyan) underline))
       (markup.raw . green)
       (diagnostic.error . ((fg red) undercurl))
       (diagnostic.warning . ((fg yellow) undercurl))
       (diagnostic.info . ((fg blue) underline))
       (diagnostic.hint . ((fg fg-dim) underline))
       (error . red)
       (warning . yellow)
       (info . blue))
     (apply append
            (map (lambda (i c)
                   (let ([peer (lambda (part) (string->symbol (format "ui.peer.~a.~a" i part)))]
                         [tint (string->symbol (format "~a-tint" c))])
                     (list (cons (peer "cursor") `((fg bg) (bg ,c)))
                           (cons (peer "selection") `((bg ,tint)))
                           (cons (peer "name") `((fg ,c) italic)))))
                 (iota 6) '(yellow green red cyan pink purple)))))

  ;; ---------------------------------------------------------------------------
  ;; The themes

  (define-palette-theme 'gruvbox-dark 'dark
    '((bg . "#282828") (bg-dark . "#1d2021") (bg-light . "#32302f") (selection . "#504945") (bg-alt . "#3c3836")
      (fg . "#ebdbb2") (fg-bright . "#fbf1c7") (fg-dim . "#7c6f64") (comment . "#928374")
      (red . "#fb4934") (orange . "#fe8019") (yellow . "#fabd2f") (green . "#b8bb26")
      (cyan . "#8ec07c") (blue . "#83a598") (purple . "#d3869b") (pink . "#d3869b"))
    '((keyword . red) (function . green) (string . cyan) (type . yellow) (operator . fg)))

  (define-palette-theme 'gruvbox-light 'light
    '((bg . "#fbf1c7") (bg-dark . "#ebdbb2") (bg-light . "#f2e5bc") (selection . "#d5c4a1") (bg-alt . "#ebdbb2")
      (fg . "#3c3836") (fg-bright . "#282828") (fg-dim . "#a89984") (comment . "#928374")
      (red . "#9d0006") (orange . "#af3a03") (yellow . "#b57614") (green . "#79740e")
      (cyan . "#427b58") (blue . "#076678") (purple . "#8f3f71") (pink . "#8f3f71"))
    '((keyword . red) (function . green) (string . cyan) (type . yellow) (operator . fg)))

  (define-palette-theme 'solarized-dark 'dark
    '((bg . "#002b36") (bg-dark . "#00212b") (bg-light . "#073642") (selection . "#274642") (bg-alt . "#073642")
      (fg . "#839496") (fg-bright . "#93a1a1") (fg-dim . "#586e75") (comment . "#586e75")
      (red . "#dc322f") (orange . "#cb4b16") (yellow . "#b58900") (green . "#859900")
      (cyan . "#2aa198") (blue . "#268bd2") (purple . "#6c71c4") (pink . "#d33682"))
    '((keyword . green) (string . cyan) (constant . cyan) (type . yellow) (operator . green)))

  (define-palette-theme 'solarized-light 'light
    '((bg . "#fdf6e3") (bg-dark . "#eee8d5") (bg-light . "#eee8d5") (selection . "#e3dcc6") (bg-alt . "#eee8d5")
      (fg . "#657b83") (fg-bright . "#586e75") (fg-dim . "#93a1a1") (comment . "#93a1a1")
      (red . "#dc322f") (orange . "#cb4b16") (yellow . "#b58900") (green . "#859900")
      (cyan . "#2aa198") (blue . "#268bd2") (purple . "#6c71c4") (pink . "#d33682"))
    '((keyword . green) (string . cyan) (constant . cyan) (type . yellow) (operator . green)))

  (define-palette-theme 'dracula 'dark
    '((bg . "#282a36") (bg-dark . "#21222c") (bg-light . "#303241") (selection . "#44475a") (bg-alt . "#383a4a")
      (fg . "#f8f8f2") (fg-bright . "#ffffff") (fg-dim . "#6272a4") (comment . "#6272a4")
      (red . "#ff5555") (orange . "#ffb86c") (yellow . "#f1fa8c") (green . "#50fa7b")
      (cyan . "#8be9fd") (blue . "#bd93f9") (purple . "#bd93f9") (pink . "#ff79c6"))
    '((keyword . pink) (function . green) (string . yellow) (constant . purple) (constant.numeric . purple)
      (type . cyan) (operator . pink)))

  (define-palette-theme 'nord 'dark
    '((bg . "#2e3440") (bg-dark . "#242933") (bg-light . "#3b4252") (selection . "#434c5e") (bg-alt . "#3b4252")
      (fg . "#d8dee9") (fg-bright . "#eceff4") (fg-dim . "#4c566a") (comment . "#616e88")
      (red . "#bf616a") (orange . "#d08770") (yellow . "#ebcb8b") (green . "#a3be8c")
      (cyan . "#8fbcbb") (blue . "#88c0d0") (purple . "#b48ead") (pink . "#b48ead"))
    '((keyword . "#81a1c1") (operator . "#81a1c1") (function . blue) (type . cyan) (constant.numeric . purple)
      (ui.statusline.normal . ((fg bg) (bg blue) bold))))

  (define-palette-theme 'catppuccin-mocha 'dark
    '((bg . "#1e1e2e") (bg-dark . "#181825") (bg-light . "#2a2b3c") (selection . "#45475a") (bg-alt . "#313244")
      (fg . "#cdd6f4") (fg-bright . "#f5e0dc") (fg-dim . "#6c7086") (comment . "#7f849c")
      (red . "#f38ba8") (orange . "#fab387") (yellow . "#f9e2af") (green . "#a6e3a1")
      (cyan . "#94e2d5") (blue . "#89b4fa") (purple . "#cba6f7") (pink . "#f5c2e7"))
    '((operator . "#89dceb") (constant.builtin . orange) (ui.statusline.normal . ((fg bg) (bg "#b4befe") bold))))

  (define-palette-theme 'catppuccin-latte 'light
    '((bg . "#eff1f5") (bg-dark . "#e6e9ef") (bg-light . "#e8eaf0") (selection . "#bcc0cc") (bg-alt . "#ccd0da")
      (fg . "#4c4f69") (fg-bright . "#dc8a78") (fg-dim . "#9ca0b0") (comment . "#8c8fa1")
      (red . "#d20f39") (orange . "#fe640b") (yellow . "#df8e1d") (green . "#40a02b")
      (cyan . "#179299") (blue . "#1e66f5") (purple . "#8839ef") (pink . "#ea76cb"))
    '((operator . "#04a5e5") (constant.builtin . orange) (ui.statusline.normal . ((fg bg) (bg "#7287fd") bold))))

  (define-palette-theme 'tokyo-night 'dark
    '((bg . "#1a1b26") (bg-dark . "#16161e") (bg-light . "#292e42") (selection . "#283457") (bg-alt . "#24283b")
      (fg . "#c0caf5") (fg-bright . "#ffffff") (fg-dim . "#3b4261") (comment . "#565f89")
      (red . "#f7768e") (orange . "#ff9e64") (yellow . "#e0af68") (green . "#9ece6a")
      (cyan . "#7dcfff") (blue . "#7aa2f7") (purple . "#bb9af7") (pink . "#bb9af7"))
    '((operator . "#89ddff") (type . "#2ac3de") (constant.builtin . orange) (ui.linenr . "#3b4261")))

  (define-palette-theme 'one-dark 'dark
    '((bg . "#282c34") (bg-dark . "#21252b") (bg-light . "#2c313c") (selection . "#3e4451") (bg-alt . "#333842")
      (fg . "#abb2bf") (fg-bright . "#e6e6e6") (fg-dim . "#4b5263") (comment . "#5c6370")
      (red . "#e06c75") (orange . "#d19a66") (yellow . "#e5c07b") (green . "#98c379")
      (cyan . "#56b6c2") (blue . "#61afef") (purple . "#c678dd") (pink . "#c678dd"))
    '((variable . red) (variable.parameter . fg)))

  (define-palette-theme 'everforest-dark 'dark
    '((bg . "#2d353b") (bg-dark . "#232a2e") (bg-light . "#343f44") (selection . "#543a48") (bg-alt . "#3d484d")
      (fg . "#d3c6aa") (fg-bright . "#e6dcc3") (fg-dim . "#7a8478") (comment . "#859289")
      (red . "#e67e80") (orange . "#e69875") (yellow . "#dbbc7f") (green . "#a7c080")
      (cyan . "#83c092") (blue . "#7fbbb3") (purple . "#d699b6") (pink . "#d699b6"))
    '((keyword . red) (function . green) (string . "#dbbc7f") (type . yellow) (operator . orange)
      (ui.statusline.normal . ((fg bg) (bg green) bold)) (ui.statusline.insert . ((fg bg) (bg blue) bold))))

  (define-palette-theme 'rose-pine 'dark
    '((bg . "#191724") (bg-dark . "#1f1d2e") (bg-light . "#21202e") (selection . "#403d52") (bg-alt . "#26233a")
      (fg . "#e0def4") (fg-bright . "#ffffff") (fg-dim . "#6e6a86") (comment . "#6e6a86")
      (red . "#eb6f92") (orange . "#ebbcba") (yellow . "#f6c177") (green . "#31748f")
      (cyan . "#9ccfd8") (blue . "#9ccfd8") (purple . "#c4a7e7") (pink . "#ebbcba"))
    '((keyword . green) (function . red) (string . yellow) (type . cyan) (operator . "#908caa")
      (diff.plus . "#9ccfd8") (ui.statusline.insert . ((fg bg) (bg "#9ccfd8") bold))))

  (define-palette-theme 'kanagawa 'dark
    '((bg . "#1f1f28") (bg-dark . "#16161d") (bg-light . "#2a2a37") (selection . "#223249") (bg-alt . "#363646")
      (fg . "#dcd7ba") (fg-bright . "#ffffff") (fg-dim . "#54546d") (comment . "#727169")
      (red . "#e46876") (orange . "#ffa066") (yellow . "#e6c384") (green . "#98bb6c")
      (cyan . "#7aa89f") (blue . "#7e9cd8") (purple . "#957fb8") (pink . "#d27e99"))
    '((type . "#7aa89f") (operator . "#c0a36e") (constant.numeric . "#d27e99") (string . green)
      (ui.statusline.normal . ((fg bg) (bg "#7e9cd8") bold))))

  ;; The terminal's own colors: the default foreground and background for
  ;; the text, its palette of 16 for the rest, whatever it is set to.
  (hashtable-set! kinds 'terminal #f)
  (define-theme 'terminal
    '((black . (ansi 0)) (red . (ansi 1)) (green . (ansi 2)) (yellow . (ansi 3)) (blue . (ansi 4))
      (magenta . (ansi 5)) (cyan . (ansi 6)) (white . (ansi 7)) (gray . (ansi 8)) (bright-white . (ansi 15)))
    (append
     '((ui . ())
       (ui.background . ())
       (ui.text . ())
       (ui.text.focus . (bold))
       (ui.text.dim . gray)
       (ui.linenr . gray)
       (ui.linenr.selected . ((fg white) bold))
       (ui.cursorline . ())
       (ui.selection . ((bg gray) (fg bright-white)))
       (ui.selection.secondary . (reverse))
       (ui.cursor . (reverse))
       (ui.cursor.primary . ((fg black) (bg bright-white)))
       (ui.cursor.match . (bold underline))
       (ui.cursor.other . ((fg black) (bg yellow)))
       (ui.statusline . (reverse))
       (ui.statusline.inactive . (reverse dim))
       (ui.statusline.normal . ((fg black) (bg blue) bold))
       (ui.statusline.insert . ((fg black) (bg green) bold))
       (ui.statusline.extend . ((fg black) (bg yellow) bold))
       (ui.statusline.selection-mode . ((fg black) (bg white)))
       (ui.statusline.dim . (reverse dim))
       (ui.window . gray)
       (ui.popup . ())
       (ui.popup.border . gray)
       (ui.popup.title . ((fg blue) bold))
       (ui.popup.key . ((fg yellow) bold))
       (ui.popup.info . ())
       (ui.menu . ())
       (ui.menu.selected . (reverse))
       (ui.menu.match . ((fg yellow) bold))
       (ui.prompt . ())
       (ui.prompt.label . ((fg blue) bold))
       (ui.jump-label . ((fg black) (bg magenta) bold))
       (ui.message . ())
       (ui.message.error . red)
       (ui.message.warning . yellow)
       (ui.virtual . gray)
       (ui.virtual.whitespace . gray)
       (ui.link . ())
       (ui.link.hover . (underline))
       (ui.gutter.blame . gray)
       (diff.plus . green)
       (diff.minus . red)
       (diff.delta . blue)
       (comment . ((fg gray) italic))
       (keyword . magenta)
       (keyword.special . ((fg magenta) bold))
       (function . blue)
       (string . green)
       (constant . yellow)
       (constant.numeric . yellow)
       (constant.character . yellow)
       (constant.builtin . cyan)
       (punctuation . ())
       (operator . cyan)
       (type . cyan)
       (variable . ())
       (special . yellow)
       (markup.heading . ((fg blue) bold))
       (markup.bold . (bold))
       (markup.italic . (italic))
       (markup.link . ((fg cyan) underline))
       (markup.raw . green)
       (diagnostic.error . ((fg red) undercurl))
       (diagnostic.warning . ((fg yellow) undercurl))
       (diagnostic.info . ((fg blue) underline))
       (diagnostic.hint . ((fg gray) underline))
       (error . red)
       (warning . yellow)
       (info . blue))
     (apply append
            (map (lambda (i c)
                   (let ([peer (lambda (part) (string->symbol (format "ui.peer.~a.~a" i part)))])
                     (list (cons (peer "cursor") `((fg black) (bg ,c)))
                           (cons (peer "selection") `((fg ,c) underline))
                           (cons (peer "name") `((fg ,c) italic)))))
                 (iota 6) '(yellow green red cyan magenta blue))))))
