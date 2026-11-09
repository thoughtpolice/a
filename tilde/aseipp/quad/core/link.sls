;; link.sls -- links in text: URLs, Markdown's links, followed by a click
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Text that leads somewhere is drawn with a face carrying the place, a
;; URL: a link. Every buffer's URLs (http, https, ftp and file ones) are
;; links, and a major mode can find more (define-link-finder!), as
;; Markdown's [text](target) does. Clients get a highlight's link with it
;; ("hl"): a terminal makes the cells a hyperlink (OSC 8).
;;
;; With ctrl held, the pointer over a link is a hand and the link is
;; underlined (ui.link.hover): ctrl-click, or space l o on the cursor's
;; link, follows it. A file: link opens the file in the editor (at line n for #Ln or
;; #n), and any other is opened by the client, on its machine, when it can
;; ("open-url"), or shown.
(library (quad link)
  (export define-link-finder! buffer-links link-at pointer-link pointer-hover!
          follow-link! file-link-path can-open-urls? open-url-here!)
  (import (chezscheme) (quad util) (quad text) (quad face) (quad buffer)
          (quad event) (quad editor) (quad display) (quad native))

  ;; ---------------------------------------------------------------------------
  ;; Finding links

  (define url-schemes '("http" "https" "ftp" "file"))

  (define (scheme-char? c)
    (or (char-alphabetic? c) (char-numeric? c) (memv c '(#\+ #\- #\.))))

  ;; What a URL can hold: anything but spaces, controls and the characters
  ;; that usually quote one.
  (define (url-char? c)
    (and (char>? c #\space) (not (char=? c #\delete))
         (not (memv c '(#\< #\> #\" #\' #\` #\\ #\^ #\{ #\} #\|)))))

  ;; The end of the URL in s from start to end, leaving out what usually
  ;; follows one in prose: closing punctuation, and closing brackets it
  ;; did not open.
  (define (url-end s start end)
    (let loop ([e end])
      (if (<= e start)
          e
          (let ([c (string-ref s (- e 1))])
            (cond
             [(memv c '(#\. #\, #\: #\; #\! #\?)) (loop (- e 1))]
             [(assv c '((#\) . #\() (#\] . #\[)))
              => (lambda (p)
                   (let count ([i start] [depth 0])
                     (cond
                      [(= i e) (if (< depth 0) (loop (- e 1)) e)]
                      [(char=? (string-ref s i) (cdr p)) (count (+ i 1) (+ depth 1))]
                      [(char=? (string-ref s i) c) (count (+ i 1) (- depth 1))]
                      [else (count (+ i 1) depth)])))]
             [else e])))))

  ;; The URLs in string s, as (start end url) lists.
  (define (find-urls s)
    (let ([n (string-length s)])
      (let loop ([i 0] [acc '()])
        (let ([k (string-contains s "://" i)])
          (if (not k)
              (reverse acc)
              (let* ([j (let back ([j k]) (if (and (> j 0) (scheme-char? (string-ref s (- j 1)))) (back (- j 1)) j))]
                     [scheme (string-downcase (substring s j k))]
                     [stop (let fwd ([e (+ k 3)]) (if (and (< e n) (url-char? (string-ref s e))) (fwd (+ e 1)) e))]
                     [e (url-end s (+ k 3) stop)])
                (if (and (member scheme url-schemes) (> e (+ k 3)))
                    (loop e (cons (list j e (substring s j e)) acc))
                    (loop (+ k 3) acc))))))))

  ;; Major modes' finders: mode name -> (line) giving (start end target
  ;; face-name) lists, for the line's text, a string. A target is a URL,
  ;; or a path, relative to the buffer's directory, with an optional
  ;; #fragment.
  (define finders (make-eq-hashtable))
  (define (define-link-finder! mode-name finder) (hashtable-set! finders mode-name finder))

  (define (has-scheme? target)
    (let ([k (string-contains target ":")])
      (and k (> k 0)
           (let loop ([i 0]) (or (= i k) (and (scheme-char? (string-ref target i)) (loop (+ i 1))))))))

  ;; target as a URL, for buffer b: a path becomes a file: URL.
  (define (resolve b target)
    (cond
     [(string=? target "") #f]
     [(has-scheme? target) target]
     [(char=? (string-ref target 0) #\#) #f]
     [else
      (let* ([dir (let ([p (buffer-path b)]) (if p (path-dirname p) (current-directory)))]
             [path (expand-home target)])
        (string-append "file://" (if (string-prefix? "/" path) path (path-join dir path))))]))

  ;; Link faces, made once for each link and face under it, so that cells
  ;; compare with eq?.
  (define link-faces (make-hashtable string-hash string=?))
  (define (link-face url base)
    (let ([inner (or (hashtable-ref link-faces url #f)
                     (let ([h (make-eq-hashtable)]) (hashtable-set! link-faces url h) h))])
      (or (hashtable-ref inner base #f)
          (let ([f (merge-faces base (make-face #f #f #f #f #f #f #f #f #f #f url))])
            (hashtable-set! inner base f)
            f))))

  ;; The links on buffer b's lines from first to last: (start end url
  ;; face) lists, positions in the buffer.
  (define (lines-links b first last)
    (let* ([t (buffer-text b)]
           [finder (hashtable-ref finders (major-mode-name (buffer-major-mode b)) #f)])
      (let loop ([line first] [acc '()])
        (if (> line last)
            acc
            (let* ([s (text-line-start t line)]
                   [str (text-substring t s (text-line-end t line))]
                   [found (append
                           (map (lambda (u) (list (car u) (cadr u) (caddr u) 'ui.link)) (find-urls str))
                           (if finder (guard (e [#t '()]) (finder str)) '()))])
              (loop (+ line 1)
                    (fold-left
                     (lambda (acc l)
                       (let ([url (resolve b (caddr l))])
                         (if url
                             (cons (list (+ s (car l)) (+ s (cadr l)) url (link-face url (face-ref (cadddr l)))) acc)
                             acc)))
                     acc found)))))))

  ;; The links between positions start and end of buffer b.
  (define (buffer-links b start end)
    (let ([t (buffer-text b)])
      (if (>= start end)
          '()
          (filter (lambda (l) (and (< (car l) end) (> (cadr l) start)))
                  (lines-links b (text-line-of t start) (text-line-of t (- end 1)))))))

  ;; The link at position pos of buffer b, as (start end url), or #f.
  (define (link-at b pos)
    (let ([t (buffer-text b)])
      (and (< pos (text-length t))
           (let ([line (text-line-of t pos)])
             (let ([l (find (lambda (l) (and (<= (car l) pos) (< pos (cadr l)))) (lines-links b line line))])
               (and l (list (car l) (cadr l) (caddr l))))))))

  ;; The link under screen cell (row, col) of client c, as (buffer start
  ;; end url), or #f: over the text, not the gutter or past a line's end.
  (define (pointer-link c row col)
    (with-client c
      (lambda ()
        (let ([g (view-geometry)] [b (current-buffer)])
          (and g b (>= col (list-ref g 1))
               (let ([pos (screen->position row col)])
                 (and pos
                      (let ([l (link-at b pos)])
                        (and l (cons b l))))))))))

  ;; The pointer moved to (row, col) on client c's screen, with modifiers
  ;; mods held: with ctrl, a click follows the link under it, which
  ;; display.sls underlines (client-local 'hover-link). Whether that
  ;; changed what c shows.
  (define (pointer-hover! c row col mods)
    (let ([l (and (logtest mods mod-ctrl) (pointer-link c row col))])
      (and (not (equal? l (client-local c 'hover-link #f)))
           (begin (client-local-set! c 'hover-link l) #t))))

  ;; ---------------------------------------------------------------------------
  ;; Following links

  (define (hex-digit c) (and c (string->number (string c) 16)))

  ;; %XX escapes decoded, as UTF-8.
  (define (percent-decode s)
    (let ([n (string-length s)])
      (if (not (string-index s #\%))
          s
          (let-values ([(out extract) (open-bytevector-output-port)])
            (let loop ([i 0])
              (when (< i n)
                (let ([c (string-ref s i)])
                  (if (and (char=? c #\%) (< (+ i 2) n)
                           (hex-digit (string-ref s (+ i 1))) (hex-digit (string-ref s (+ i 2))))
                      (begin (put-u8 out (+ (* 16 (hex-digit (string-ref s (+ i 1)))) (hex-digit (string-ref s (+ i 2)))))
                             (loop (+ i 3)))
                      (begin (put-bytevector out (string->utf8 (string c))) (loop (+ i 1)))))))
            (utf8->string (extract))))))

  ;; A file: URL's path and line (from #Ln or #n), or #f for another URL.
  (define (file-link-path url)
    (and (string-prefix? "file://" url)
         (let* ([rest (substring url 7 (string-length url))]
                [rest (if (string-prefix? "localhost/" rest) (substring rest 9 (string-length rest)) rest)]
                [hash (string-index rest #\#)]
                [path (percent-decode (if hash (substring rest 0 hash) rest))]
                [frag (and hash (substring rest (+ hash 1) (string-length rest)))]
                [line (and frag (string->number (if (string-prefix? "L" frag) (substring frag 1 (string-length frag)) frag)))])
           (and (string-prefix? "/" path)
                (cons path (and line (integer? line) (exact? line) (> line 0) line))))))

  ;; Follow url for the current client.
  (define (follow-link! url)
    (let ([file (file-link-path url)] [c (current-client)])
      (cond
       [file
        (let ([b (switch-to-buffer! (open-file! (car file)))])
          (when (cdr file)
            (let* ([t (buffer-text b)]
                   [s (text-line-start t (clamp (- (cdr file) 1) 0 (- (text-line-count t) 1)))])
              (set-sels! b (list (make-sel s s))))))]
       [(and c (client-has? c "open-url"))
        (client-send! c (list "open-url" url))
        (message "Opening ~a" url)]
       [else (message "Link: ~a" url)])))

;; ---------------------------------------------------------------------------
  ;; Opening URLs, in a client

  ;; Whether this process can open a URL for its user: it runs in their
  ;; desktop session, where xdg-open hands it to the browser, say.
  (define (can-open-urls?) (and (getenv "WAYLAND_DISPLAY") #t))

  (define (open-url-here! url)
    (when (can-open-urls?)
      (guard (e [#t (void)]) (launch-process (list "xdg-open" url)))))

  ;; Every buffer's links are drawn with their faces.
  (at-load
   (add-decorator!
    (lambda (b start end)
      (map (lambda (l) (list (car l) (cadr l) (cadddr l))) (buffer-links b start end))))))
