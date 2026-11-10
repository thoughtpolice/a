;; setup.ss -- quad's setup: the questions, the init file from the answers,
;; and the editor as they say
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Run without -q, with QUAD_INIT naming a file that is not there (BUILD
;; does): as quad starts the first time.

(define path (init-file-path))
(check "no init file yet" (and path (not (file-exists? path))))
(headless-start! 40 100)
(define themes (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) (theme-names)))
(define theme-before (current-theme-name))

;; The first client of an editor started with no init file is asked: a
;; splash, and a checklist, each entry opened with enter.
(run-hooks 'interactive-start-hook (current-client))
(redraw!)
(check "the splash" (and (on-screen? "Setting up quad") (on-screen? "██████") (on-screen? "[ Save and start ]")))
(check "where it will write" (on-screen? "init.ss"))
(check "nothing checked yet" (and (on-screen? "○  Keys") (on-screen? "Ki: quad's own")))
(press! "enter")
(check "keys, opened" (on-screen? "Setting up quad · Keys"))
(press! "down" "enter")
(check "keys: checked, and set" (and (on-screen? "✓  Keys") (on-screen? "Vim: motions")))
(press! "enter")
(check "theme, next" (on-screen? "Setting up quad · Theme"))
(press! "down")
(define chosen (current-theme-name))
(check "a theme shows as it is chosen" (not (eq? chosen theme-before)))
(press! "enter")
(check "the theme's name" (on-screen? (symbol->string chosen)))
(press! "enter")
(check "AI" (and (on-screen? "Setting up quad · AI") (on-screen? "not yet")))
;; Claude is there, but cannot be chosen: down from Codex is None.
(press! "up" "up" "down" "enter")
(check "AI: none" (on-screen? "AI         none"))
(press! "enter")
(check "editing" (on-screen? "Setting up quad · Editing"))
(press! "down" "enter")
(check "editing: relative" (on-screen? "relative line numbers"))
(press! "enter" "enter")
(check "afterward: the tutor for Vim's" (on-screen? "open the tutor for Vim's keys"))
(press! "enter")
(check "review: what it will write"
       (and (on-screen? "Setting up quad · Review") (on-screen? "(set-var! 'key-scheme 'vim)")
            (on-screen? "(set-var! 'ai-provider #f)")))
(press! "enter")
(check "all checked" (not (on-screen? "○")))
(press! "enter")

;; Written, loaded, and on: with Vim's keys and its tutor.
(check "written" (file-exists? path))
(define written (read-file-string path))
(check "the init file says so" (and (string-contains written "(set-var! 'key-scheme 'vim)")
                                    (string-contains written (format "(set-var! 'theme '~a)" chosen))
                                    (string-contains written "(set-var! 'line-numbers 'relative)")))
(check "loaded" (and (eq? (get-var 'key-scheme) 'vim) (eq? (current-theme-name) chosen)
                     (eq? (get-var 'line-numbers) 'relative) (not (get-var 'ai-provider))))
(check "the tutor for Vim's keys" (equal? (buffer-contents) vim-tutor-text))
(check "no error loading it" (not (on-screen? "Error in")))

;; Asked again: escape puts an entry back as it was, and leaves the rest.
(press! "space" "j" "i")
(check "asked again" (on-screen? "Setting up quad"))
(press! "down" "enter" "down")
(check "another theme shows" (not (eq? (current-theme-name) chosen)))
(press! "esc")
(check "escape: the theme as it was" (eq? (current-theme-name) chosen))
(press! "esc")
(check "not now: the file as it was" (equal? (read-file-string path) written))
;; And saved straight away: the old one is kept.
(press! "space" "j" "i" "up" "up" "enter")
(check "the old one kept" (equal? (read-file-string (string-append path ".bak")) written))
(set-var! 'key-scheme 'ki)
