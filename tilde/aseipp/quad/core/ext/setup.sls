;; setup.sls -- quad's setup: a few questions, and a configuration from them
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The first time quad starts with a window or a terminal and no init file
;; (~/.config/quad/init.ss, or $QUAD_INIT), it shows a splash: one large
;; popup, quad's banner, and a checklist of what to set -- which keys,
;; which theme (each shown as it is chosen), which AI to change the editor
;; with, how the text should look, what to do once it starts -- each opened
;; with enter, and the file they make, to review. Save and start writes
;; them as an init file (Scheme, with a word on each setting, to change as
;; you like), loads it, and goes on, with the tutor for the chosen keys if
;; you like. `space j i`
;; (the command `setup`) asks again: the init file there is kept beside the
;; new one, as init.ss.bak. -q, which loads no init file, asks nothing.
(library (quad ext setup)
  (export setup! setup-config-text)
  (import (chezscheme) (quad util) (quad face) (quad buffer) (quad editor) (quad commands)
          (quad canvas) (quad widget) (quad form) (quad anim) (quad ext themes))

  ;; Whether this editor was started with -q.
  (define skipped? #f)

  ;; ---------------------------------------------------------------------------
  ;; The init file the answers make

  (define (answer answers key default)
    (let ([a (assq key answers)])
      (cond [(not a) default] [(string? (cdr a)) (or (string->number (cdr a)) (cdr a))] [else (cdr a)])))

  (define (scheme-value v)
    (cond [(symbol? v) (format "'~a" v)] [(eq? v #t) "#t"] [(eq? v #f) "#f"] [else (format "~s" v)]))

  ;; The init file for answers (an alist, as the wizard gives them).
  (define (setup-config-text answers)
    (let ([set (lambda (name comment)
                 (format ";; ~a\n(set-var! '~a ~a)\n\n" comment name
                         (scheme-value (answer answers name (get-var name)))))])
      (string-append
       ";; init.ss -- quad's configuration: Scheme, loaded as quad starts, with all\n"
       ";; of quad in scope. quad's setup wrote it (space j i asks again and\n"
       ";; writes it anew, keeping this one as init.ss.bak); change it as you\n"
       ";; like. quad's README, and its docs/examples/init.ss, show what else can\n"
       ";; go here: keys, commands, modes, hooks.\n\n"
       (set 'key-scheme "The keys: 'ki (quad's own), 'vim or 'helix. space j s picks among them.")
       (set 'theme "The colors. space k t picks among the themes, showing each.")
       (set 'ai-provider "The AI that space a asks to change the editor: 'codex, or #f for none.")
       (set 'line-numbers "Line numbers: 'absolute, 'relative (to the cursor's line) or #f.")
       (set 'cursorline "Highlight the cursor's line.")
       (set 'show-whitespace "Show tabs and spaces at the ends of lines.")
       (set 'trim-trailing-whitespace "Remove spaces at the ends of lines on saving.")
       (set 'auto-pairs "Type closing brackets and quotes with the opening ones.")
       (set 'system-clipboard "Copy to the system's clipboard too.")
       (set 'gui-font-size "The size of a window's text, in points."))))

  ;; ---------------------------------------------------------------------------
  ;; The questions

  ;; Where program is in PATH, or #f.
  (define (find-program program)
    (let ([path (getenv "PATH")])
      (and path
           (find (lambda (f) (and (file-exists? f) (not (file-directory? f))))
                 (map (lambda (d) (path-join d program))
                      (filter (lambda (d) (not (string=? d ""))) (string-split path #\:)))))))

  (define (index-of x l) (let loop ([l l] [i 0]) (cond [(null? l) 0] [(equal? (car l) x) i] [else (loop (cdr l) (+ i 1))])))

  (define (option label value detail) (list label value detail #t))

  ;; The banner: "quad" in blocks, in the colors of the theme's modes
  ;; (normal, insert, extend: those of the status line), top to bottom.
  (define banner-rows
    '((" ██████  ██    ██  █████  ██████  " . ui.statusline.normal)
      ("██    ██ ██    ██ ██   ██ ██   ██ " . ui.statusline.normal)
      ("██    ██ ██    ██ ███████ ██   ██ " . ui.statusline.insert)
      ("██ ▄▄ ██ ██    ██ ██   ██ ██   ██ " . ui.statusline.insert)
      (" ██████   ██████  ██   ██ ██████  " . ui.statusline.extend)
      ("    ▀▀                            " . ui.statusline.extend)))

  ;; The popup's face, with face name's over it -- or, for a mode's (the
  ;; status line's), its background as the text's color.
  (define (popup-face name)
    (let ([f (F name)])
      (face-merge (UI 'ui.popup)
                  (if (and (string-prefix? "ui.statusline." (symbol->string name)) (face-bg f))
                      (make-face (face-bg f) #f)
                      f))))

  ;; Lines of text, each (string . face-name), in the middle of the popup;
  ;; with effect fx over them, if given.
  (define middle
    (case-lambda
     [(lines) (middle lines #f)]
     [(lines fx)
      (let* ([width (+ 2 (apply max 0 (map (lambda (l) (string-length (car l))) lines)))]
             [text (text-lines (lambda () (map (lambda (l) (cons (car l) (popup-face (cdr l)))) lines)))])
        (centered (if fx (with-effect text fx) text) width))]))

  ;; Light across the banner now and then (docs/animation.md).
  (define (banner-sheen)
    (effect 'sheen 'angle 20 'width 4 'intensity 0.65 'color #xffffff
            'duration 1500 'delay 500 'end-delay 3500 'loop #t 'easing 'in-out-sine))

  ;; The banner and the welcome; the welcome alone, if the banner leaves it
  ;; no room.
  (define (header path)
    (let* ([welcome (welcome path)]
           [full (pile (middle banner-rows (banner-sheen))
                       (padded (middle '(("an editor you change as it runs" . ui.text.dim))) 1 0 0 0)
                       (padded welcome 1 0 0 0))])
      (make-widget
       (lambda (cols) (widget-rows full cols))
       (lambda (g row col rows cols)
         (if (>= rows (widget-rows full cols))
             (widget-draw! full g row col rows cols)
             (widget-draw! welcome g row col rows cols))))))

  (define (welcome path)
          (text-lines
                   (lambda ()
                     (map (lambda (l) (cons (car l) (popup-face (cdr l))))
                          `(("Welcome. A few things to set, and quad writes them as your configuration and starts. Move to one and press enter to set it; anything left as it is keeps the default. Every answer can change later: it is a Scheme file, and space j i shows this again." . ui.popup)
                            ("" . ui.popup)
                            (,(format "It goes in ~a~a" path
                                      (if (file-exists? path) ", keeping the one there now as init.ss.bak." "."))
                             . ui.text.dim))))))

  (define schemes
    '((ki "Ki" "quad's own: select first, by selection modes and layers")
      (vim "Vim" "motions, operators, text objects, visual mode, . and macros")
      (helix "Helix" "selection first, every motion on every selection")))

  (define (entries path)
    (let* ([codex (find-program "codex")]
           [themes (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) (theme-names))]
           [ais (list (option "Codex" 'codex
                              (if codex "OpenAI's Codex (installed)" "OpenAI's Codex: npm install -g @openai/codex first"))
                      (list "Claude" 'claude "Anthropic's Claude: not yet" #f)
                      (option "None" #f "space a asks no one"))]
           [yes (lambda (v) (if v "on" "off"))])
      (list
       (checklist-entry
        "Keys"
        (lambda (vals) (let ([s (assq (answer vals 'key-scheme 'ki) schemes)]) (if s (string-append (cadr s) ": " (caddr s)) "")))
        '(("How should keys work? Each scheme has quad's space menu (space / lists every key), panes (ctrl+w) and insert mode." . ui.popup))
        (list (radio 'key-scheme ""
                     (map (lambda (s) (option (cadr s) (car s) (caddr s))) schemes)
                     (index-of (get-var 'key-scheme) (map car schemes)))))
       (checklist-entry
        "Theme"
        (lambda (vals) (symbol->string (answer vals 'theme (current-theme-name))))
        '(("Which colors? Each is shown as you choose it; escape puts back the one you had. The terminal's own takes your terminal's colors as they are set." . ui.popup))
        (list (radio 'theme ""
                     (map (lambda (t)
                            (option (symbol->string t) t
                                    (case t
                                      [(quad-default) "quad's own: Helix's purple"]
                                      [(terminal) "the terminal's own colors"]
                                      [else (case (theme-kind t) [(light) "light"] [(dark) "dark"] [else #f])])))
                          themes)
                     (index-of (current-theme-name) themes)
                     load-theme!)))
       (checklist-entry
        "AI"
        (lambda (vals) (case (answer vals 'ai-provider #f) [(codex) "Codex changes the editor for you (space a)"] [else "none"]))
        '(("quad can be changed by an AI as it runs: space a a, then say what you want (a command, a key, a mode), and it writes your configuration and applies it, as you watch." . ui.popup))
        (list (radio 'ai-provider "" ais (if codex 0 2))))
       (checklist-entry
        "Editing"
        (lambda (vals)
          (format "~a line numbers, ~a-point text in windows~a~a"
                  (case (answer vals 'line-numbers 'absolute) [(absolute) "absolute"] [(relative) "relative"] [else "no"])
                  (answer vals 'gui-font-size 12)
                  (if (answer vals 'show-whitespace #f) ", whitespace shown" "")
                  (if (answer vals 'trim-trailing-whitespace #f) ", trimmed on save" "")))
        '(("How should the text look, and what should quad do for you?" . ui.popup))
        (list (radio 'line-numbers "Line numbers"
                     (list (option "Absolute" 'absolute "each line's number")
                           (option "Relative" 'relative "how far from the cursor's line, for counts")
                           (option "None" #f #f))
                     (index-of (get-var 'line-numbers) '(absolute relative #f)))
              (toggle 'cursorline "Highlight the cursor's line" (get-var 'cursorline))
              (toggle 'show-whitespace "Show tabs and trailing spaces" (get-var 'show-whitespace))
              ;; On, the first time; asked again, as it is now.
              (toggle 'trim-trailing-whitespace "Trim trailing spaces on saving"
                      (or (not (file-exists? path)) (get-var 'trim-trailing-whitespace)))
              (toggle 'auto-pairs "Pair brackets and quotes" (get-var 'auto-pairs))
              (toggle 'system-clipboard "Copy to the system clipboard" (get-var 'system-clipboard))
              (choose 'gui-font-size "Text size in windows" '("11" "12" "13" "14" "16" "18")
                      (index-of (number->string (get-var 'gui-font-size)) '("11" "12" "13" "14" "16" "18")))))
       (checklist-entry
        "Afterward"
        (lambda (vals)
          (if (answer vals 'tutor #f)
              (let ([s (assq (answer vals 'key-scheme 'ki) schemes)])
                (format "open the tutor for ~a's keys" (if s (cadr s) "these")))
              "start editing"))
        '(("The tutor teaches the keys you chose in half an hour, by doing: lessons, each with lines to practise on. space k h opens it any time." . ui.popup))
        (list (toggle 'tutor "Open the tutor once quad starts" (not (file-exists? path)))))
       (checklist-entry
        "Review"
        (lambda (vals) (string-append "what goes in " (path-basename path)))
        (lambda (vals)
          (map (lambda (l) (cons l (if (string-prefix? ";" l) 'ui.text.dim 'ui.popup)))
               (filter (lambda (l) (not (string=? l "")))
                       (string-split (setup-config-text vals) #\newline))))
        '()))))

  ;; ---------------------------------------------------------------------------
  ;; Asking

  (define (write-config! path text)
    (let mkdir-p ([d (path-dirname path)])
      (unless (file-exists? d) (mkdir-p (path-dirname d)) (mkdir d)))
    (when (file-exists? path)
      (let ([bak (string-append path ".bak")])
        (when (file-exists? bak) (delete-file bak))
        (rename-file path bak)))
    (call-with-output-file path (lambda (p) (display text p))))

  ;; Ask, then write the init file, load it, and go on.
  (define (setup!)
    (let ([path (init-file-path)] [theme (current-theme-name)] [c (current-client)])
      (if (not path)
          (message-error "There is nowhere for an init file: set HOME, XDG_CONFIG_HOME or QUAD_INIT")
          (show-checklist!
           "Setting up quad" (header path) (entries path)
           (list (cons "Save and start" (lambda (answers) (with-client c (lambda () (save! path answers)))))
                 (cons "Not now" (lambda (answers) (with-client c (lambda () (skipped! path theme))))))
           (lambda () (with-client c (lambda () (skipped! path theme))))))))

  (define (save! path answers)
    (guard (e [#t (message-error "Could not write ~a: ~a" path (condition->string e))])
      (write-config! path (setup-config-text answers))
      (load-init-file! path)
      (when (answer answers 'tutor #f) (run-command 'tutor))
      (message "Wrote ~a. space opens quad's menu; space / lists every key." path)))

  (define (skipped! path theme)
    (load-theme! theme)
    (message (if (file-exists? path)
                 "Nothing changed (space j i asks again)"
                 "No configuration yet: quad asks again next time, or now with space j i")))

  (at-load
   (define-command 'setup "Answer a few questions, and write an init file from them" setup!)
   (define-key (keymap-lookup-target space-keymap "j") "i" 'setup "Setup")
   (add-hook! 'skip-configuration-hook (lambda () (set! skipped? #t)))
   (add-hook! 'interactive-start-hook
              (lambda (c)
                (let ([path (init-file-path)])
                  (when (and path (not skipped?) (not (file-exists? path)))
                    (run-command 'setup)))))))
