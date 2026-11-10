;; people.sls -- working together: who is here, following someone, chat
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Everyone attached to an editor -- on this machine, or from anywhere over
;; iroh (`quad --mesh`) -- edits the same buffers: one editor, so there is
;; nothing to merge. Each person has a name (the client says it; $QUAD_USER,
;; else user@host) and a color, and sees the others' cursors and selections
;; in their colors, with their names (see display.sls). This adds:
;;
;;   space j l    people: who is here, and where; choose one to follow
;;   space j t    say something to everyone
;;   space j h    the chat so far
;;
;; Following someone keeps your view on theirs -- their buffer, their
;; cursor, their scroll -- until you press a key. Everyone hears when
;; someone joins or leaves.
(library (quad ext people)
  (export follow! unfollow! following say! announce! chat-lines define-person-note!)
  (import (chezscheme) (quad util) (quad text) (quad buffer) (quad event)
          (quad editor) (quad commands) (quad display))

  ;; Tell every person but `except` (#f: everyone).
  (define (tell! except fmt . args)
    (let ([text (apply format fmt args)])
      (for-each (lambda (c) (unless (eq? c except) (with-client c (lambda () (message "~a" text)))))
                (people))))

  ;; ---------------------------------------------------------------------------
  ;; Chat: what people said, and who came and went, in *chat*

  (define lines '())                    ; newest first
  (define (chat-lines) (reverse lines))

  (define (log! text)
    (set! lines (cons text lines))
    (let ([b (find-buffer-named "*chat*")])
      (when b
        (buffer-read-only?-set! b #f)
        (buffer-insert! b (buffer-length b) (string-append text "\n"))
        (buffer-read-only?-set! b #t))))

  ;; Tell everyone but `except` (#f: everyone) something that happened,
  ;; and note it in *chat*.
  (define (announce! except fmt . args)
    (let ([text (apply format fmt args)])
      (log! text)
      (tell! except "~a" text)))

  ;; Say text to everyone, as the current client's person.
  (define (say! text)
    (announce! #f "~a: ~a" (client-user (current-client)) text))

  (define (show-chat!)
    (let ([b (or (find-buffer-named "*chat*")
                 (let ([b (new-buffer! "*chat*" (apply string-append (map (lambda (l) (string-append l "\n")) (chat-lines)))
                                       fundamental-mode)])
                   (buffer-read-only?-set! b #t)
                   b))])
      (switch-to-buffer! b)))

  ;; ---------------------------------------------------------------------------
  ;; Following

  (define (following c) (client-local c 'following #f))
  (define (followers c) (filter (lambda (o) (eq? (following o) c)) (people)))

  ;; Follow leader, as the current client.
  (define (follow! leader)
    (let ([me (current-client)])
      (cond
       [(eq? leader me) (message "That is you")]
       [(not (memq leader (clients))) (message "~a is not here" (client-user leader))]
       [else
        (client-local-set! me 'following leader)
        (track! leader)
        (message "Following ~a: any key stops" (client-user leader))
        (with-client leader (lambda () (message "~a is following you" (client-user me))))])))

  (define (unfollow!)
    (let* ([me (current-client)] [leader (following me)])
      (when leader
        (client-local-set! me 'following #f)
        (message "Stopped following ~a" (client-user leader)))))

  ;; Said at the next frame, unless the key said something itself: keys
  ;; clear the message as they are handled.
  (define (say-later! c text) (client-local-set! c 'people-pending text))

  ;; The current client's view onto leader's: its buffer, its selections
  ;; (so the view scrolls with them), its scroll.
  (define (track! leader)
    (let ([lv (client-view leader)])
      (when lv
        (unless (eq? (view-buffer (current-view)) (view-buffer lv))
          (switch-to-buffer! (view-buffer lv)))
        (let ([v (current-view)])
          (view-sels-set! v (list (view-primary lv)))
          (view-input-mode-set! v 'normal)
          (view-top-set! v (view-top lv))
          (view-left-set! v (view-left lv))))))

  ;; Before each frame of a follower.
  (define (before-render! c)
    (let ([pending (client-local c 'people-pending #f)])
      (when pending
        (client-local-set! c 'people-pending #f)
        (unless (current-message) (message "~a" pending))))
    (let ([leader (following c)])
      (when leader
        (if (memq leader (clients))
            (track! leader)
            (begin (client-local-set! c 'following #f)
                   (message "~a left; no longer following" (client-user leader)))))))

  ;; A follower's key (or click) takes over.
  (define (before-event! ev)
    (let ([me (current-client)])
      (when (and me (following me)
                 (or (and (key-event? ev) (key-event-press? ev)) (mouse-event? ev)))
        (say-later! me (format "Stopped following ~a" (client-user (following me))))
        (client-local-set! me 'following #f))))

  ;; ---------------------------------------------------------------------------
  ;; People

  (define (where c)
    (let ([v (client-view c)])
      (if v
          (let* ([b (view-buffer v)] [t (buffer-text b)]
                 [pos (sel-start (view-primary v))])
            (format "~a:~a~a" (buffer-display-name b) (+ 1 (text-line-of t (min pos (text-length t))))
                    (if (eq? (view-input-mode v) 'insert) ", typing" "")))
          "nowhere yet")))

  ;; What else the people list says about each person: procedures from a
  ;; client to a string, or #f (voice adds who is in it).
  (define person-notes '())
  (define (define-person-note! proc) (set! person-notes (append person-notes (list proc))))

  (define (notes c)
    (apply string-append
           (map (lambda (s) (string-append "  " s))
                (filter string?
                        (cons (let ([l (following c)]) (and l (format "following ~a" (client-user l))))
                              (map (lambda (note) (note c)) person-notes))))))

  (define (people-picker!)
    (let ([me (current-client)])
      (pick "People"
            (map (lambda (c)
                   (cons (format "~a~a  ~a~a" (client-user c) (if (eq? c me) " (you)" "") (where c) (notes c))
                         c))
                 (people))
            follow!
            'picker "Choose someone to follow: your view keeps to theirs until you press a key.")))

  (define (status v)
    (let* ([me (view-client v)] [leader (following me)] [fs (followers me)])
      (cond
       [leader (cons (format " following ~a " (client-user leader)) 'ui.statusline.insert)]
       [(pair? fs) (cons (format " followed by ~a " (string-join (map client-user fs) ", ")) 'ui.statusline.dim)]
       [else #f])))

  (at-load
   (add-hook! 'client-user-hook
              (lambda (c old)
                (when (person? c)
                  (if old
                      (announce! c "~a is now ~a" old (client-user c))
                      (announce! c "~a joined" (client-user c))))))
   (add-hook! 'client-detach-hook
              (lambda (c)
                (when (person? c) (announce! c "~a left" (client-user c)))))
   (add-hook! 'before-render-hook before-render!)
   (add-hook! 'before-event-hook before-event!)
   (define-status-segment! 'right status)

   (define-command 'people "Who is here, and where; choose someone to follow" people-picker!)
   (define-command 'follow "Follow someone: keep your view on theirs until a key" people-picker!)
   (define-command 'unfollow "Stop following" unfollow!)
   (define-command 'say "Say something to everyone here"
     (lambda ()
       (read-string-dialog "Say to everyone" "Everyone here sees it, and it goes in *chat*."
                           (lambda (s) (unless (string=? (string-trim s) "") (say! s))))))
   (define-command 'chat "What people said, and who came and went" show-chat!)

   (let ([editor (keymap-lookup-target space-keymap "j")])
     (define-key editor "l" 'people "People")
     (define-key editor "t" 'say "Say")
     (define-key editor "h" 'chat "Chat"))))
