;; regions.ss -- regions over a buffer's text, and buffers rendered from them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 60)

;; Regions move with edits (text put just before one is not in it; just
;; after, is), nest innermost first, and go when emptied.
(define b (headless-buffer! "one two three" 'text))
(buffer-add-region! b 4 7 '((data . two)))
(buffer-add-region! b 0 13 '((data . all) (kind . line)))
(buffer-edit! b '((0 0 "zero ")))
(expect-equal "a region moves" (map (lambda (r) (list (region-start r) (region-end r))) (buffer-regions b))
              '((5 18) (9 12)))
(expect-equal "the innermost first" (map (lambda (r) (region-get r 'data)) (regions-at b 10)) '(two all))
(expect-equal "a property of an outer region" (region-property b 10 'kind) 'line)
(buffer-edit! b '((9 12 "")))
(expect-equal "an emptied region goes" (map (lambda (r) (region-get r 'data)) (buffer-regions b)) '(all))

;; A rendered buffer: items, with keys of their own, and the data at
;; the cursor.
(define picked #f)
(define item-keys (make-keymap 'item "Item"))
(define-command 'regions-test-pick "Pick the item at the cursor" (lambda () (set! picked (data-at-point))))
(define-key item-keys "enter" 'regions-test-pick "Pick")
(define (render! names)
  (buffer-render! list-buffer
                  (span '((face . ui.text.focus)) "Fruit\n")
                  (map (lambda (n) (span `((item . #t) (data . ,n) (keymap . ,item-keys)) n "\n")) names)))
(define list-buffer (rendered-buffer! "*fruit*" 'text))
(switch-to-buffer! list-buffer)
(render! '("apple" "banana" "cherry"))
(redraw!)
(check "the rendered text is shown" (on-screen? "banana"))
(check "read-only" (buffer-read-only? list-buffer))
(check "and unmodified" (not (buffer-modified? list-buffer)))
(check "with no undo" (not (buffer-undo! list-buffer #t)))

;; The item selection mode steps between them.
(set-selection-mode! list-buffer 'item)
(set-sels! list-buffer (list (make-sel 7 7)))
(press! "l")
(expect-equal "the next item" (primary-text) "banana\n")
(press! "enter")
(expect-equal "its keys, with its data" picked "banana")
(press! "j")
(expect-equal "the previous item" (primary-text) "apple\n")
(press! "enter")
(expect-equal "and that one's" picked "apple")

;; Rendered again, in another order, the cursor stays on its item.
(press! "l")
(render! '("cherry" "banana" "date" "apple"))
(expect-equal "the cursor follows its item" (primary-text) "banana\n")
(render! '("cherry" "date"))
(check "and, its item gone, stays on its line" (string-prefix? "date" (primary-text)))
