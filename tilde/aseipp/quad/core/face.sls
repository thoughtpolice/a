;; face.sls -- faces and themes
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A face is a foreground, a background and attributes; colors are 24-bit
;; integers, or #f to inherit. Faces are named with dotted symbols, Helix
;; style ('ui.statusline.insert, 'keyword.control), and a name that the theme
;; lacks falls back to its parent ('ui.statusline, then 'ui).
(library (quad face)
  (export make-face face? face-fg face-bg face-bold? face-italic? face-underline?
          face-undercurl? face-dim? face-reverse? merge-faces face-ref
          define-theme load-theme! current-theme-name theme-names set-face!
          palette-color default-face)
  (import (chezscheme) (quad util))

  (define-record-type face
    (fields fg bg bold? italic? underline? undercurl? dim? reverse?)
    (protocol
     (lambda (new)
       (case-lambda
        [(fg bg) (new fg bg #f #f #f #f #f #f)]
        [(fg bg bold? italic? underline? undercurl? dim? reverse?)
         (new fg bg bold? italic? underline? undercurl? dim? reverse?)]))))

  (define default-face (make-face #f #f))

  ;; `top` drawn over `base`: its colors and attributes win where set.
  (define (merge-faces base top)
    (make-face (or (face-fg top) (face-fg base))
               (or (face-bg top) (face-bg base))
               (or (face-bold? top) (face-bold? base))
               (or (face-italic? top) (face-italic? base))
               (or (face-underline? top) (face-underline? base))
               (or (face-undercurl? top) (face-undercurl? base))
               (or (face-dim? top) (face-dim? base))
               (or (face-reverse? top) (face-reverse? base))))

  (define themes (make-eq-hashtable))
  (define current-faces (make-eq-hashtable))
  (define current-palette '())
  (define current-name #f)
  (define cache (make-eq-hashtable))

  (define (current-theme-name) current-name)
  (define (theme-names) (vector->list (hashtable-keys themes)))

  (define (palette-color c)
    (cond
     [(not c) #f]
     [(integer? c) c]
     [(string? c)
      (string->number (substring c 1 (string-length c)) 16)]
     [(symbol? c)
      (let ([p (assq c current-palette)])
        (if p (palette-color (cdr p)) (errorf 'palette-color "unknown color ~s" c)))]
     [else (errorf 'palette-color "bad color ~s" c)]))

  ;; A face spec: a color (the foreground), or a list of
  ;; (fg c) (bg c) bold italic underline undercurl dim reverse.
  (define (spec->face spec)
    (if (or (symbol? spec) (string? spec) (integer? spec))
        (make-face (palette-color spec) #f)
        (let ([get (lambda (k) (let ([p (assq k (filter pair? spec))]) (and p (palette-color (cadr p)))))]
              [has (lambda (k) (and (memq k spec) #t))])
          (make-face (get 'fg) (get 'bg) (has 'bold) (has 'italic) (has 'underline)
                     (has 'undercurl) (has 'dim) (has 'reverse)))))

  (define (parent-name sym)
    (let* ([s (symbol->string sym)]
           [i (let loop ([i (- (string-length s) 1)])
                (cond [(< i 0) #f] [(char=? (string-ref s i) #\.) i] [else (loop (- i 1))]))])
      (and i (string->symbol (substring s 0 i)))))

  (define (face-ref name)
    (or (hashtable-ref cache name #f)
        (let ([f (let loop ([n name])
                   (cond
                    [(not n) default-face]
                    [(hashtable-ref current-faces n #f) => values]
                    [else (loop (parent-name n))]))])
          (hashtable-set! cache name f)
          f)))

  (define (set-face! name spec)
    (hashtable-set! current-faces name (spec->face spec))
    (hashtable-clear! cache))

  ;; (define-theme name palette faces): palette is an alist of color names
  ;; to "#rrggbb", faces an alist of face names to specs.
  (define (define-theme name palette faces)
    (hashtable-set! themes name (cons palette faces)))

  (define (load-theme! name)
    (let ([t (hashtable-ref themes name #f)])
      (unless t (errorf 'load-theme! "no theme named ~s" name))
      (set! current-palette (car t))
      (set! current-name name)
      (hashtable-clear! current-faces)
      (hashtable-clear! cache)
      (for-each (lambda (p) (set-face! (car p) (cdr p))) (cdr t))))

  ;; The look of Helix's default theme.
  (define-theme 'quad-default
    '((white . "#ffffff") (lilac . "#dbbfef") (lavender . "#a4a0e8")
      (comet . "#5a5977") (bossanova . "#452859") (midnight . "#3b224c")
      (revolver . "#281733") (silver . "#cccccc") (sirocco . "#697c81")
      (mint . "#9ff28f") (almond . "#eccdba") (chamois . "#e8dca0")
      (honey . "#efba5d") (apricot . "#f47868") (lightning . "#ffcd1c")
      (delta . "#6f44f0") (selection . "#540099") (help . "#7958dc")
      (deep . "#171452") (match . "#6c6999")
      ;; People, told apart: each a color and a dark tint of it.
      (sky . "#7cc7ff") (pink . "#ff8ad8") (lime . "#d5f26b")
      (honey-dim . "#5a4520") (mint-dim . "#2f5a2a") (apricot-dim . "#5e2a26")
      (sky-dim . "#24445e") (pink-dim . "#5e2a52") (lime-dim . "#4d5a20"))
    '((ui . ((fg lavender) (bg midnight)))
      (ui.background . ((bg midnight)))
      (ui.text . lavender)
      (ui.text.focus . white)
      (ui.text.dim . comet)
      (ui.linenr . comet)
      (ui.linenr.selected . lilac)
      (ui.cursorline . ((bg "#43285a")))
      (ui.selection . ((bg selection)))
      (ui.selection.secondary . ((bg "#3d1e66")))
      (ui.cursor . ((fg revolver) (bg lavender)))
      (ui.cursor.primary . ((fg revolver) (bg white)))
      (ui.cursor.match . ((bg match)))
      (ui.cursor.other . ((fg revolver) (bg honey)))
      (ui.peer.0.cursor . ((fg revolver) (bg honey))) (ui.peer.0.selection . ((bg honey-dim))) (ui.peer.0.name . ((fg honey) italic))
      (ui.peer.1.cursor . ((fg revolver) (bg mint))) (ui.peer.1.selection . ((bg mint-dim))) (ui.peer.1.name . ((fg mint) italic))
      (ui.peer.2.cursor . ((fg revolver) (bg apricot))) (ui.peer.2.selection . ((bg apricot-dim))) (ui.peer.2.name . ((fg apricot) italic))
      (ui.peer.3.cursor . ((fg revolver) (bg sky))) (ui.peer.3.selection . ((bg sky-dim))) (ui.peer.3.name . ((fg sky) italic))
      (ui.peer.4.cursor . ((fg revolver) (bg pink))) (ui.peer.4.selection . ((bg pink-dim))) (ui.peer.4.name . ((fg pink) italic))
      (ui.peer.5.cursor . ((fg revolver) (bg lime))) (ui.peer.5.selection . ((bg lime-dim))) (ui.peer.5.name . ((fg lime) italic))
      (ui.statusline . ((fg white) (bg revolver)))
      (ui.statusline.inactive . ((fg lavender) (bg revolver)))
      (ui.statusline.normal . ((fg revolver) (bg lilac) bold))
      (ui.statusline.insert . ((fg revolver) (bg mint) bold))
      (ui.statusline.extend . ((fg revolver) (bg honey) bold))
      (ui.statusline.selection-mode . ((fg white) (bg bossanova)))
      (ui.statusline.dim . ((fg comet) (bg revolver)))
      (ui.popup . ((fg lavender) (bg revolver)))
      (ui.popup.border . ((fg comet) (bg revolver)))
      (ui.popup.title . ((fg lilac) (bg revolver) bold))
      (ui.popup.key . ((fg honey) (bg revolver) bold))
      (ui.popup.info . ((fg lavender) (bg revolver)))
      (ui.menu . ((fg lavender) (bg revolver)))
      (ui.menu.selected . ((fg revolver) (bg lilac)))
      (ui.menu.match . ((fg honey) bold))
      (ui.prompt . ((fg white) (bg midnight)))
      (ui.prompt.label . ((fg lilac) bold))
      (ui.jump-label . ((fg white) (bg "#c41d7f") bold))
      (ui.message . lavender)
      (ui.message.error . apricot)
      (ui.message.warning . lightning)
      (ui.virtual . comet)
      (ui.virtual.whitespace . bossanova)
      (comment . ((fg sirocco) italic))
      (keyword . almond)
      (keyword.special . ((fg lilac) bold))
      (function . white)
      (string . silver)
      (constant . white)
      (constant.numeric . chamois)
      (constant.character . honey)
      (constant.builtin . honey)
      (punctuation . lavender)
      (punctuation.bracket . lavender)
      (operator . lilac)
      (type . white)
      (variable . lavender)
      (special . honey)
      (markup.heading . ((fg lilac) bold))
      (markup.bold . ((fg lilac) bold))
      (markup.italic . ((fg lilac) italic))
      (markup.link . ((fg honey) underline))
      (markup.raw . silver)
      (diagnostic.error . ((fg apricot) undercurl))
      (diagnostic.warning . ((fg lightning) undercurl))
      (diagnostic.info . ((fg delta) underline))
      (diagnostic.hint . ((fg comet) underline))
      (error . apricot)
      (warning . lightning)
      (info . delta)))

  (load-theme! 'quad-default))
