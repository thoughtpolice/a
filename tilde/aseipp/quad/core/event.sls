;; event.sls -- input events, as any client reports them
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Clients turn whatever their input is -- terminal escape sequences, window
;; system events -- into these, and send them to the server (protocol.sls
;; has their wire form). Keymaps name keys by spec strings, as
;; key-event->spec writes them: "j", "J", "alt+k", "ctrl+z", "shift+enter",
;; "space", "esc".
(library (quad event)
  (export make-key-event key-event? key-event-name key-event-mods key-event-text
          key-event-kind key-event->spec key-event-press? spec->key-event
          char-key special-key
          make-paste-event paste-event? paste-event-text
          make-mouse-event mouse-event? mouse-event-kind mouse-event-button
          mouse-event-col mouse-event-row mouse-event-mods
          make-clipboard-event clipboard-event? clipboard-event-target clipboard-event-text
          make-focus-event focus-event? focus-event-in?
          mod-shift mod-alt mod-ctrl mod-super)
  (import (chezscheme) (quad util))

  (define mod-shift 1)
  (define mod-alt 2)
  (define mod-ctrl 4)
  (define mod-super 8)

  ;; name: "a", "A", "<", "enter", "esc", "space", "left", "f5", ...
  ;; text: what the key types, or #f. kind: press, repeat or release.
  (define-record-type key-event (fields name mods text kind))
  (define-record-type paste-event (fields text))
  ;; kind: press, release, drag, move (no button held), scroll-up or
  ;; scroll-down; 0-based cells.
  (define-record-type mouse-event (fields kind button col row mods))
  ;; The system clipboard's contents, answering the server's request for
  ;; them: target is "c" (the clipboard) or "p" (the primary selection).
  (define-record-type clipboard-event (fields target text))
  (define-record-type focus-event (fields in?))

  (define (key-event-press? e) (not (eq? (key-event-kind e) 'release)))

  ;; The key as keymaps spell it: modifiers, in the order ctrl, alt, super,
  ;; shift, then the name. Shift is folded into printable characters.
  (define (key-event->spec e)
    (let ([m (key-event-mods e)])
      (string-append
       (if (logtest m mod-ctrl) "ctrl+" "")
       (if (logtest m mod-alt) "alt+" "")
       (if (logtest m mod-super) "super+" "")
       (if (logtest m mod-shift) "shift+" "")
       (key-event-name e))))

  (define (printable-name c)
    (if (char=? c #\space) "space" (string c)))

  ;; A printable key. Shift is part of the character, except for space.
  (define (char-key c mods kind)
    (let ([mods (if (char=? c #\space) mods (logand mods (lognot mod-shift)))])
      (make-key-event (printable-name c) mods
                      (and (zero? (logand mods (logior mod-ctrl mod-alt mod-super)))
                           (string c))
                      kind)))

  (define (special-key name mods kind)
    (make-key-event name mods (if (string=? name "enter") "\n" #f) kind))

  ;; The press of the key a spec names: the inverse of key-event->spec.
  (define spec->key-event
    (case-lambda
     [(spec) (spec->key-event spec 'press)]
     [(spec kind)
      (let loop ([s spec] [mods 0])
        (let ([try (lambda (p m)
                     (and (string-prefix? p s) (> (string-length s) (string-length p))
                          (loop (substring s (string-length p) (string-length s)) (logior mods m))))])
          (or (try "ctrl+" mod-ctrl) (try "alt+" mod-alt) (try "super+" mod-super)
              (try "shift+" mod-shift)
              (cond
               [(string=? s "space") (char-key #\space mods kind)]
               [(= (string-length s) 1) (char-key (string-ref s 0) mods kind)]
               [else (special-key s mods kind)]))))])))
