;; input.sls -- the mouse, pastes, focus and scrolling, and titles
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; What a client's pointer, wheel, pastes and focus do to its view
;; (commands.sls installs it), and the title a client shows.
(library (quad input)
  (export
          page scroll-page! center-view! define-click-handler! input-install!)
  (import (chezscheme) (quad util) (quad text) (quad event) (quad face)
          (quad syntax) (quad buffer) (quad selection) (quad editor) (quad edit))

  ;; ---------------------------------------------------------------------------
  ;; Scrolling

  (define (scroll! lines)
    (let* ([b (cur)] [n (text-line-count (buffer-text b))])
      (view-top-set! (cv) (clamp (+ (view-top (cv)) lines) 0 (max 0 (- n 1))))
      (view-local-set! (cv) 'free-scroll #t)))

  (define (page) (let ([g (view-geometry)]) (if g (list-ref g 2) 20)))

  ;; Page up and down move the selection by the page too.
  (define (scroll-page! dir)
    (let* ([b (cur)] [t (buffer-text b)] [lines (* dir (quotient (page) 2))]
           [line (clamp (+ (text-line-of t (sel-range-start (primary))) lines) 0 (- (text-line-count t) 1))])
      (scroll! lines)
      (view-local-set! (cv) 'free-scroll #f)
      (let ([r (current-unit b (cons (line-indent-end t line) (line-indent-end t line)))])
        (when r (set-sels! b (list (range->sel r)))))))

  (define (center-view!)
    (let* ([b (cur)] [line (text-line-of (buffer-text b) (sel-range-start (primary)))])
      (view-top-set! (cv) (max 0 (- line (quotient (page) 2))))
      (view-local-set! (cv) 'free-scroll #t)))

  ;; ---------------------------------------------------------------------------
  ;; The mouse
  ;;
  ;; Click selects the unit of the current selection mode under the pointer;
  ;; double-click selects a word and triple-click a line (switching modes);
  ;; dragging extends; shift-click extends to the pointer; ctrl-click
  ;; follows a link (the link extension), and elsewhere adds a cursor, as alt-click
  ;; does; middle-click pastes the primary selection; the wheel scrolls.

  (define last-click #f)   ; (time pos count)
  (define drag-anchor #f)

  (define (unit-at b pos)
    (or (current-unit b (cons pos (min (buffer-length b) (+ pos 1)))) (cons pos pos)))

  ;; A press focuses the pane under the pointer; the wheel scrolls that
  ;; pane, focused or not.
  (define (on-mouse ev)
    (let* ([c (current-client)]
           [under (pane-at c (mouse-event-row ev) (mouse-event-col ev))]
           [focused (client-focused-pane c)])
      (case (mouse-event-kind ev)
        [(scroll-up scroll-down)
         (when under (focus-pane! c under))
         (scroll! (if (eq? (mouse-event-kind ev) 'scroll-up) -3 3))
         (focus-pane! c focused)]
        [else
         (when (and under (eq? (mouse-event-kind ev) 'press) (not (current-prompt)))
           (focus-pane! c under))
         (on-mouse-here ev)])))

  ;; The mouse, over the focused pane.
  (define (on-mouse-here ev)
    (let ([b (cur)] [pos (screen->position (mouse-event-row ev) (mouse-event-col ev))])
      (case (mouse-event-kind ev)
        [(press)
         (when (and pos (not (current-prompt)))
           (exit-layer!)
           (case (mouse-event-button ev)
             [(0) (click! b pos (mouse-event-mods ev))]
             [(1) (paste-primary-at! b pos)]
             [else (void)]))]
        [(drag) (when (and pos drag-anchor (= (mouse-event-button ev) 0)) (drag-to! b pos))]
        [(release) (when drag-anchor (end-drag! b))])))

  ;; How many clicks at pos this one makes: one more than the last, if
  ;; that was there, under 400 ms ago.
  (define (click-count! pos)
    (let* ([now (real-time)]
           [count (if (and last-click (< (- now (car last-click)) 400) (= pos (cadr last-click)))
                      (+ 1 (caddr last-click))
                      1)])
      (set! last-click (list now pos count))
      count))

  ;; What extensions do with a left click: name -> (handler b pos mods),
  ;; true if it took the click (with ctrl held, the link extension follows
  ;; the link there).
  (define click-handlers '())
  (define (define-click-handler! name handler)
    (set! click-handlers (append (remp (lambda (h) (eq? (car h) name)) click-handlers)
                                 (list (cons name handler)))))

  ;; A left click at pos: an extension's, if one takes it; shift extends the
  ;; selection, alt (or ctrl) adds one; else it selects the unit there (a
  ;; word on a double click, a line on a triple) and starts a drag.
  (define (click! b pos mods)
    (let ([count (click-count! pos)])
      (when (eq? (view-input-mode (cv)) 'insert) (exit-insert!))
      (push-selection-history! b)
      (cond
       [(exists (lambda (h) ((cdr h) b pos mods)) click-handlers) (void)]
       [(logtest mods mod-shift)
        (let ([r (unit-at b pos)] [p (primary)])
          (set-sels! b (cons (make-sel (car r) (cdr r) (or (sel-anchor p) (sel-range p))) (cdr (sels-of b)))))]
       [(logtest mods (logior mod-alt mod-ctrl))
        (set-sels! b (cons (range->sel (unit-at b pos)) (sels-of b)))]
       [else
        (case (min count 3)
          [(2) (set-selection-mode! b 'word)]
          [(3) (set-selection-mode! b 'line)]
          [else (void)])
        (let ([r (unit-at b pos)])
          (set! drag-anchor r)
          (set-sels! b (list (range->sel r))))])))

  ;; A middle click: the primary selection's text, pasted at pos.
  (define (paste-primary-at! b pos)
    (let ([s (primary-selection)])
      (when (> (string-length s) 0)
        (run-command (lambda ()
                       (let ([starts (buffer-edit! b (list (list pos pos s)))])
                         (set-sels! b (list (make-sel (car starts) (+ (car starts) (string-length s)))))))))))

  ;; Dragging: the selection reaches from where the drag began to pos.
  (define (drag-to! b pos)
    (let ([r (unit-at b pos)])
      (set-sels! b (list (make-sel (car r) (cdr r) drag-anchor)))
      (view-local-set! (cv) 'free-scroll #f)))

  ;; The drag is done: what it selected becomes the primary selection.
  (define (end-drag! b)
    (let ([p (primary)])
      (when (sel-anchor p)
        (set-sels! b (list (sel-collapse p)))
        (primary-selection-set! (selection-text b (primary)))))
    (set! drag-anchor #f))




  ;; Pasting from the terminal (bracketed paste): typed in insert mode, and
  ;; in normal mode it replaces the selections.



  ;; Clients that show a title (a terminal's, a window's) show the buffer's,
  ;; and learn the working directory, for new terminal tabs.
  (define (send-title! c b)
    (when (client-has? c "title")
      (client-send! c (list "title" (string-append "quad — " (buffer-name b))))))




  ;; Coming back to the terminal: reload files changed on disk behind
  ;; unmodified buffers, and warn about modified ones.




  ;; What this registers, once: (quad commands) calls it as it loads, as
  ;; nothing would run this library's own at-loads (a library runs only
  ;; once something uses it).
  (define (input-install!)
    (add-hook! 'mouse-hook on-mouse)
    (add-hook! 'paste-hook
             (lambda (text)
               (run-command
                (lambda ()
                  (let ([b (cur)])
                    (if (eq? (view-input-mode (cv)) 'insert)
                        (edit-sels! (lambda (s) (list (sel-start s) (sel-start s) text
                                                      (lambda (np) (let ([q (+ np (string-length text))]) (make-sel q q))))))
                        (replace-with! (make-list (length (sels-of b)) text))))))))
    (add-hook! 'client-attach-hook
              (lambda (c)
                (client-send! c (list "cwd" (current-directory)))
                (let ([v (client-view c)]) (when v (send-title! c (view-buffer v))))))
   (add-hook! 'buffer-switch-hook (lambda (b) (send-title! (current-client) b)))
    (add-hook! 'focus-in-hook
             (lambda ()
               (for-each
                (lambda (b)
                  (let ([p (buffer-path b)])
                    (when (and p (file-exists? p) (buffer-local b 'mtime #f)
                               (not (equal? (file-modification-time p) (buffer-local b 'mtime #f))))
                      (if (buffer-modified? b)
                          (message-error "~a changed on disk; space j d reloads it" (buffer-name b))
                          (begin (reload-buffer! b) (message "Reloaded ~a" (buffer-name b)))))))
                (buffers))))))
