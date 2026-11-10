;; ki.sls -- Ki's keys: the way to edit quad starts with
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Ki (ki-editor.github.io) edits by selection mode: choose the unit (s a
;; word, a a line, d a syntax node, ...), then the same eight keys move by
;; it (j l i k, u o, y p), and actions (r delete, x cut, c copy, v paste,
;; g change) act on what is selected, each a layer of its own that a tap
;; runs the commonest of. This is the key scheme 'ki (keymap.sls), the
;; default; the tutor (space k h) teaches it.
;;
;; The bindings are Ki's (https://ki-editor.org), on QWERTY:
;;
;;   movements        j/l left/right  i/k up/down  u/o previous/next
;;                    y/p first/last  m jump  M index  . parent line
;;   selection modes  a LINE  A LINE*  s WORD  S WORD*  w SUBWORD  W CHAR
;;                    d/D NODE  E PARAGRAPH  n local menu (n d to search)
;;   actions          h/; insert before/after  g change (layer: open)
;;                    r delete (layer)  x cut (layer)  c copy (layer: dup)
;;                    v replace (layer: paste)  t swap (layer)  b multi-cursor
;;                    z undo (layer)  Z redo  I join  K break  L/J indent
;;                    F transform  , surround  f extend  enter save
;;                    e buffers (layer)  q selection history  space menu
;;
;; A "layer" is momentary: hold its key and press a movement (r then l
;; deletes rightwards); tap it alone for its default. On terminals without
;; the kitty keyboard protocol, press the layer key twice for the default.
(library (quad ext ki)
  (export ki-keymap)
  (import (chezscheme) (quad util) (quad editor) (quad commands))

  (define ki-keymap (make-keymap 'ki "Ki"))

  (define movements
    '(("j" left "<<") ("l" right ">>") ("i" up "^") ("k" down "v")
      ("u" previous "<") ("o" next ">") ("y" first "|<") ("p" last ">|")))

  (define (movement-layer name title on-tap prefix label-fmt dirs)
    (let ([km (make-keymap name title on-tap)])
      (for-each (lambda (m)
                  (when (memq (cadr m) dirs)
                    (define-key km (car m) (string->symbol (format "~a-~a" prefix (cadr m)))
                      (format label-fmt (caddr m)))))
                movements)
      km))

  (define delete-layer
    (layer 'delete "Delete" 'delete-one
           "j" 'delete-left "<< Delete" "l" 'delete-right "Delete >>"
           "u" 'delete-previous "< Delete" "o" 'delete-next "Delete >"
           "y" 'delete-to-first "|< Delete" "p" 'delete-to-last "Delete >|"))

  (define cut-layer
    (layer 'cut "Cut" 'cut-one
           "j" 'cut-left "<< Cut" "l" 'cut-right "Cut >>"
           "u" 'cut-previous "< Cut" "o" 'cut-next "Cut >"
           "y" 'cut-to-first "|< Cut" "p" 'cut-to-last "Cut >|"))

  (define open-layer
    (layer 'open "Open" 'change
           "j" 'open-before "<< Open" "l" 'open-after "Open >>"
           "u" 'open-before "< Open" "o" 'open-after "Open >"
           "h" 'insert-before "< Insert" ";" 'insert-after "Insert >"
           "i" 'open-above "Open ^" "k" 'open-below "Open v"))

  (define copy-layer
    (layer 'copy "Copy / Dup" 'copy
           "j" 'duplicate-gap-before "<< Gap Dup" "l" 'duplicate-gap-after "Gap Dup >>"
           "u" 'duplicate-gap-before "< Gap Dup" "o" 'duplicate-gap-after "Gap Dup >"
           "h" 'duplicate-before "< Dup" ";" 'duplicate-after "Dup >"
           "i" 'duplicate-above "Dup ^" "k" 'duplicate-below "Dup v"))

  (define paste-layer
    (layer 'paste "Paste" 'replace
           "j" 'paste-gap-before "<< Gap Paste" "l" 'paste-gap-after "Gap Paste >>"
           "u" 'paste-gap-before "< Gap Paste" "o" 'paste-gap-after "Gap Paste >"
           "h" 'paste-before "< Paste" ";" 'paste-after "Paste >"
           "i" 'paste-above "Paste ^" "k" 'paste-below "Paste v"
           "y" 'replace-history-older "← Replace History" "p" 'replace-history-newer "Replace History →"
           "n" 'replace-cut "Replace Cut" "b" 'paste-system "System Clipboard"))

  (define undo-layer
    (layer 'undo "Undo / Redo" 'undo
           "j" 'undo "Coarse Undo" "l" 'redo "Coarse Redo"
           "u" 'undo-fine "Fine Undo" "o" 'redo-fine "Fine Redo"))

  (define swap-layer
    (movement-layer 'swap "Swap" #f "swap" "Swap ~a" '(left right up down previous next first last)))
  (at-load (keymap-momentary?-set! swap-layer #t))

  (define multicursor-layer
    (let ([km (movement-layer 'multi-cursor "Multi-cursor" #f "add-cursor" "Add Curs ~a"
                              '(left right up down previous next first last))])
      (bind km "h" 'cursor-previous "← Curs" ";" 'cursor-next "Curs →"
            "n" 'cursor-delete "Delete Curs" "f" 'select-all-occurrences "All Occurrences")
      (keymap-momentary?-set! km #t)
      km))

  (define buffer-layer
    (let ([km (layer 'buffers "Buffers" 'switch-buffer
                     "j" 'buffer-previous "<< Buffer" "l" 'buffer-next "Buffer >>"
                     "n" 'buffer-close "Close" "m" 'buffer-alternate "Alternate"
                     "f" 'switch-buffer "Pick")])
      km))

  (define history-layer
    (layer 'history "Selection History" 'selection-back
           "j" 'selection-back "<< Hist" "l" 'selection-forward "Hist >>"
           "u" 'selection-back "< Hist" "o" 'selection-forward "Hist >"))

  (at-load (bind ki-keymap
        "j" 'move-left "<<" "l" 'move-right ">>" "i" 'move-up "^" "k" 'move-down "v"
        "u" 'move-previous "<" "o" 'move-next ">" "y" 'move-first "|<" "p" 'move-last ">|"
        "m" 'jump "Jump" "M" 'goto-index "Index" "." 'parent-line "Parent Line"
        "a" 'select-line "LINE" "A" 'select-line-full "LINE*" "d" 'select-node "NODE"
        "D" 'select-node "NODE*" "s" 'select-word "WORD" "S" 'select-big-word "WORD*"
        "w" 'select-subword "SUBWORD" "W" 'select-char "CHAR" "E" 'select-paragraph "PARAGRAPH"
        "n" local-keymap "Local" "f" 'extend "Extend"
        "h" 'insert-before "← Insert" ";" 'insert-after "Insert →"
        "g" open-layer "Change/Open" "G" 'change-cut "Change X"
        "r" delete-layer "Delete" "x" cut-layer "Cut" "c" copy-layer "Copy/Dup"
        "v" paste-layer "Replace/Paste" "t" swap-layer "Swap" "b" multicursor-layer "Multi-cursor"
        "z" undo-layer "Undo/Redo" "Z" 'redo "Redo"
        "I" 'join "Join" "K" 'break "Break" "L" 'indent "Indent" "J" 'dedent "Dedent"
        "F" transform-keymap "Transform" "," surround-keymap "Surround"
        "enter" 'save "Save" "shift+enter" 'save-as "Save As"
        "e" buffer-layer "Buffer" "q" history-layer "Selection History"
        "?" 'swap-anchor "⇋ Anchor" "/" 'swap-cursor "⇋ Cursor"
        "backspace" 'selection-back "← Select" "tab" 'selection-forward "Select →"
        "alt+k" 'scroll-down "Scroll ↓" "alt+i" 'scroll-up "Scroll ↑"
        "alt+;" 'center "Align View"
        "left" 'move-left "<<" "right" 'move-right ">>" "up" 'move-up "^" "down" 'move-down "v"))

  (at-load
   (define-key-scheme! 'ki "Ki" "Ki's: selection modes, then movements and actions by them" ki-keymap)))
