;; buffer.sls -- buffers, the views onto them, undo, and files
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A buffer is text and what belongs to it alone: its file, major mode,
;; undo history and local variables. A view is one client's window onto a
;; buffer: selections, input mode, selection mode, scroll position. Several
;; views, from several clients, can show one buffer, each with its own
;; selections; an edit through any of them remaps the selections of all.
;;
;; Every edit goes through buffer-edit!, which applies a set of
;; non-overlapping changes at once (one per selection, typically) and records
;; them for undo, with the selections of the view making the edit (the
;; current edit view). Undo history is a stack of groups, each a list of
;; transactions: an action in normal mode is one group, and a whole insert
;; session is another, so coarse undo reverts a group and fine undo a single
;; transaction.
(library (quad buffer)
  (export
   ;; selections
   make-sel sel? sel-start sel-end sel-anchor sel-range-start sel-range-end
   sel-collapse sel-length
   ;; major modes
   make-major-mode major-mode? major-mode-name major-mode-syntax
   major-mode-keymap major-mode-hook major-mode-hook-set!
   ;; buffers
   make-buffer buffer? buffer-name buffer-name-set! buffer-path buffer-path-set!
   buffer-text buffer-major-mode buffer-major-mode-set! buffer-locals buffer-views
   buffer-hl-cache buffer-read-only? buffer-read-only?-set!
   buffer-modified? buffer-version buffer-length buffer-substring buffer-string
   buffer-edit! buffer-insert! buffer-delete! buffer-replace-all!
   buffer-undo! buffer-redo! buffer-begin-group! buffer-end-group!
   buffer-mark-saved! buffer-tree buffer-local buffer-local-set!
   ;; views
   make-view view? view-buffer view-client view-sels view-sels-set! view-primary
   view-input-mode view-input-mode-set! view-selection-mode view-selection-mode-set!
   view-top view-top-set! view-left view-left-set! view-sticky-col view-sticky-col-set!
   view-cursor-start? view-cursor-start?-set! view-extending? view-extending?-set!
   view-last-seen view-last-seen-set! view-local view-local-set!
   attach-view! detach-view! current-edit-view set-current-edit-view! position-mapper
   ;; regions
   make-region region? region-start region-end region-props region-get
   buffer-regions buffer-add-region! buffer-clear-regions! buffer-set-regions!
   regions-at regions-in region-property
   buffer-set-text!
   add-change-listener! remove-change-listener!
   read-file-string write-file-string)
  (import (chezscheme) (quad util) (quad text) (quad syntax))

  ;; A selection: the range [start, end), and when it is being extended, the
  ;; range it was extended from. The selected text is the hull of the two.
  (define-record-type sel
    (fields start end anchor)
    (protocol
     (lambda (new)
       (case-lambda
        [(s e) (new (min s e) (max s e) #f)]
        [(s e anchor) (new (min s e) (max s e) anchor)]))))

  (define (sel-range-start s)
    (if (sel-anchor s) (min (sel-start s) (car (sel-anchor s))) (sel-start s)))
  (define (sel-range-end s)
    (if (sel-anchor s) (max (sel-end s) (cdr (sel-anchor s))) (sel-end s)))
  (define (sel-collapse s) (make-sel (sel-range-start s) (sel-range-end s)))
  (define (sel-length s) (- (sel-range-end s) (sel-range-start s)))

  (define-record-type major-mode
    (fields name syntax keymap (mutable hook)))

  (define-record-type buffer
    (fields (mutable name) (mutable path) text
            (mutable major-mode) locals
            (mutable undo) (mutable redo) (mutable group)
            (mutable saved-version) hl-cache (mutable read-only?)
            (mutable tree-cache) (mutable views))
    (protocol
     (lambda (new)
       ;; contents: a string, or a text (read-text-file's).
       (lambda (name path contents major-mode)
         (new name path (if (text? contents) contents (make-text contents)) major-mode (make-eq-hashtable)
              '() '() #f 0 (make-hl-cache) #f #f '())))))

  (define (buffer-version b) (text-version (buffer-text b)))
  (define (buffer-modified? b) (not (= (buffer-version b) (buffer-saved-version b))))
  (define (buffer-mark-saved! b) (buffer-saved-version-set! b (buffer-version b)))
  (define (buffer-length b) (text-length (buffer-text b)))
  (define (buffer-substring b s e) (text-substring (buffer-text b) s e))
  (define (buffer-string b) (text->string (buffer-text b)))

  ;; ---------------------------------------------------------------------------
  ;; Views

  (define-record-type view
    (fields buffer client
            (mutable sels) (mutable input-mode) (mutable selection-mode)
            (mutable top) (mutable left) (mutable sticky-col)
            (mutable cursor-start?) (mutable extending?) (mutable last-seen)
            locals)
    (protocol
     (lambda (new)
       (lambda (buffer client)
         (new buffer client
              (list (make-sel 0 (min 1 (buffer-length buffer))))
              'normal 'char 0 0 #f #f #f 0 (make-eq-hashtable))))))

  (define (view-primary v) (car (view-sels v)))
  (define (view-local v key default) (hashtable-ref (view-locals v) key default))
  (define (view-local-set! v key x) (hashtable-set! (view-locals v) key x))

  (define (attach-view! v)
    (let ([b (view-buffer v)])
      (unless (memq v (buffer-views b))
        (buffer-views-set! b (cons v (buffer-views b))))))

  (define (detach-view! v)
    (let ([b (view-buffer v)])
      (buffer-views-set! b (remq v (buffer-views b)))))

  ;; The view whose selections an edit records for undo, and which undo
  ;; restores them to: the editor sets it to the view of the client whose
  ;; command is running.
  (define the-edit-view #f)
  (define (current-edit-view) the-edit-view)
  (define (set-current-edit-view! v) (set! the-edit-view v))

  ;; Where positions land after `changes`, sorted (start end text) in the
  ;; coordinates before them: a procedure from a position to where it
  ;; lands, each found by a binary search. Positions inside a replaced range
  ;; keep their offset into the replacement, as far as it reaches.
  (define (position-mapper changes)
    (let* ([n (length changes)]
           [starts (make-vector n)] [lens (make-vector n)]
           ;; The shift before each change, and the most any change up to
           ;; it reaches: a position is moved by the first change that
           ;; reaches past it, and those reaches only grow.
           [deltas (make-vector n)] [reach (make-vector n)]
           [total (let loop ([cs changes] [i 0] [delta 0] [most 0])
                    (if (null? cs)
                        delta
                        (let* ([c (car cs)] [s (car c)] [e (cadr c)] [len (string-length (caddr c))])
                          (vector-set! starts i s)
                          (vector-set! lens i len)
                          (vector-set! deltas i delta)
                          (vector-set! reach i (max most e))
                          (loop (cdr cs) (+ i 1) (+ delta (- len (- e s))) (max most e)))))])
      (lambda (p)
        (let search ([lo 0] [hi n])
          (if (< lo hi)
              (let ([mid (quotient (+ lo hi) 2)])
                (if (< p (vector-ref reach mid)) (search lo mid) (search (+ mid 1) hi)))
              (if (= lo n)
                  (+ p total)
                  (let ([s (vector-ref starts lo)] [delta (vector-ref deltas lo)])
                    (if (< p s)
                        (+ p delta)
                        (+ s delta (min (- p s) (vector-ref lens lo)))))))))))

  (define (remap-views! b mapped)
    (let ([len (buffer-length b)])
      (for-each
       (lambda (v)
         (let ([m (lambda (p) (clamp (mapped p) 0 len))])
           (view-sels-set! v (map (lambda (s)
                                    (make-sel (m (sel-start s)) (m (sel-end s))
                                              (let ([a (sel-anchor s)]) (and a (cons (m (car a)) (m (cdr a)))))))
                                  (view-sels v)))))
       (buffer-views b))))

  ;; ---------------------------------------------------------------------------
  ;; Regions
  ;;
  ;; A region is a range of a buffer's text, [start, end), that carries
  ;; properties, an alist: what an extension says of that text. The editor
  ;; knows a few -- face (drawn over it), keymap (consulted first for a key
  ;; pressed with the cursor in it), item (one of the things a list shows,
  ;; which the item selection mode steps between), data (what it stands
  ;; for, to the extension) -- and any other is the extension's own.
  ;; Regions move with edits, as selections do; one left empty goes.
  ;; Regions may nest: the innermost at a position comes first.

  (define-record-type region (fields (mutable start) (mutable end) props))

  (define region-get
    (case-lambda
     [(r key) (region-get r key #f)]
     [(r key default) (let ([p (assq key (region-props r))]) (if p (cdr p) default))]))

  ;; Sorted by start, then the longer (the outer) first.
  (define (buffer-regions b) (buffer-local b 'regions '()))
  (define (buffer-regions-set! b rs) (buffer-local-set! b 'regions rs))

  (define (region<? x y)
    (or (< (region-start x) (region-start y))
        (and (= (region-start x) (region-start y)) (> (region-end x) (region-end y)))))

  (define (buffer-add-region! b start end props)
    (let ([r (make-region start end props)])
      (when (< start end)
        (buffer-regions-set! b (merge region<? (buffer-regions b) (list r))))
      r))

  (define (buffer-clear-regions! b) (buffer-regions-set! b '()))

  ;; Make b's regions these, each (start end props), at once.
  (define (buffer-set-regions! b specs)
    (buffer-regions-set! b (sort region<? (filter-map (lambda (s)
                                                        (and (< (car s) (cadr s))
                                                             (make-region (car s) (cadr s) (caddr s))))
                                                      specs))))

  ;; The regions over position pos, innermost first.
  (define (regions-at b pos)
    (let loop ([rs (buffer-regions b)] [acc '()])
      (cond
       [(or (null? rs) (> (region-start (car rs)) pos)) acc]
       [(< pos (region-end (car rs))) (loop (cdr rs) (cons (car rs) acc))]
       [else (loop (cdr rs) acc)])))

  ;; The regions that overlap [start, end), in order.
  (define (regions-in b start end)
    (let loop ([rs (buffer-regions b)] [acc '()])
      (if (or (null? rs) (>= (region-start (car rs)) end))
          (reverse acc)
          (loop (cdr rs) (if (> (region-end (car rs)) start) (cons (car rs) acc) acc)))))

  ;; key's value in the innermost region at pos that has it, or default.
  (define region-property
    (case-lambda
     [(b pos key) (region-property b pos key #f)]
     [(b pos key default)
      (let ([r (find (lambda (r) (assq key (region-props r))) (regions-at b pos))])
        (if r (region-get r key) default))]))

  (define (remap-regions! b mapped)
    (let ([rs (buffer-regions b)])
      (unless (null? rs)
        (for-each (lambda (r)
                    (region-start-set! r (mapped (region-start r)))
                    (region-end-set! r (mapped (region-end r))))
                  rs)
        (buffer-regions-set! b (sort region<? (filter (lambda (r) (< (region-start r) (region-end r))) rs))))))

  (define (clamp-sels b sels)
    (let ([len (buffer-length b)])
      (map (lambda (s) (make-sel (clamp (sel-start s) 0 len) (clamp (sel-end s) 0 len))) sels)))

  (define (edit-view-of b)
    (let ([v the-edit-view]) (and v (eq? (view-buffer v) b) v)))

  (define (buffer-local b key default) (hashtable-ref (buffer-locals b) key default))
  (define (buffer-local-set! b key v) (hashtable-set! (buffer-locals b) key v))

  ;; The node tree of the buffer's text, reparsed after each edit.
  (define (buffer-tree b)
    (let ([c (buffer-tree-cache b)] [v (buffer-version b)])
      (if (and c (= (car c) v))
          (cdr c)
          (let ([root (parse-tree (major-mode-syntax (buffer-major-mode b)) (buffer-text b))])
            (buffer-tree-cache-set! b (cons v root))
            root))))

  ;; ---------------------------------------------------------------------------
  ;; Editing

  ;; Procedures told of every change to every buffer's text, undo and redo
  ;; too: (listener buffer changes) just before they are made, with the old
  ;; text still there to measure them by. changes are (start end text),
  ;; sorted and apart, in the old text's positions; made last to first, so
  ;; each one's positions hold until it is made. Language servers are kept in
  ;; step this way.
  (define change-listeners '())
  (define (add-change-listener! f) (set! change-listeners (append change-listeners (list f))))
  (define (remove-change-listener! f) (set! change-listeners (remq f change-listeners)))

  (define (newlines s)
    (let loop ([i 0] [n 0])
      (if (= i (string-length s)) n (loop (+ i 1) (if (char=? (string-ref s i) #\newline) (+ n 1) n)))))

  ;; Apply changes, each (start end text), to the text: sorted, applied last
  ;; to first, recorded as a transaction unless `record?` is false (or they
  ;; change nothing). Returns the list of new start positions, in the order
  ;; the changes were given.
  (define (apply-changes! b changes record? sels-before)
    (when (buffer-read-only? b) (errorf 'edit "buffer ~a is read-only" (buffer-name b)))
    (let* ([t (buffer-text b)]
           [len (text-length t)]
           [indexed (let loop ([l changes] [i 0])
                      (if (null? l) '()
                          (let* ([c (car l)]
                                 [s (clamp (car c) 0 len)] [e (clamp (cadr c) s len)])
                            (cons (list s e (caddr c) i) (loop (cdr l) (+ i 1))))))]
           [sorted (sort (lambda (a b) (or (< (car a) (car b))
                                           (and (= (car a) (car b)) (< (cadddr a) (cadddr b)))))
                         indexed)]
           [old-texts (map (lambda (c) (text-substring t (car c) (cadr c))) sorted)]
           ;; The changes, sorted, as (start end text).
           [cs (map (lambda (c) (list (car c) (cadr c) (caddr c))) sorted)]
           [result (make-vector (length changes) 0)])
      (unless (null? sorted)
        (for-each (lambda (f) (f b cs)) change-listeners))
      ;; The lines changed, measured in the old text, for the highlighter.
      (let ([lines (and (pair? sorted)
                        (list (text-line-of t (car (car sorted)))
                              (text-line-of t (cadr (car (last-pair sorted))))
                              (fold-left (lambda (n c old) (+ n (- (newlines (caddr c)) (newlines old))))
                                         0 sorted old-texts)))])
        ;; Apply from the last change backwards, so earlier positions hold.
        (for-each
         (lambda (c)
           (text-delete! t (car c) (cadr c))
           (text-insert! t (car c) (caddr c)))
         (reverse sorted))
        (when lines (apply hl-cache-edit! (buffer-hl-cache b) lines)))
      (let ([mapped (position-mapper cs)])
        (remap-views! b mapped)
        (remap-regions! b mapped))
      ;; New starts: each change shifts the ones after it.
      (let loop ([l sorted] [delta 0])
        (unless (null? l)
          (let ([c (car l)])
            (vector-set! result (cadddr c) (+ (car c) delta))
            (loop (cdr l) (+ delta (- (string-length (caddr c)) (- (cadr c) (car c))))))))
      (when (and record?
                 (exists (lambda (c) (or (< (car c) (cadr c)) (> (string-length (caddr c)) 0))) sorted))
        (let ([tx (list (map (lambda (c old) (list (car c) old (caddr c))) sorted old-texts)
                        sels-before)])
          (buffer-redo-set! b '())
          (if (buffer-group b)
              (buffer-group-set! b (cons tx (buffer-group b)))
              (buffer-undo-set! b (cons (list tx) (buffer-undo b))))))
      (vector->list result)))

  (define (buffer-edit! b changes)
    (apply-changes! b changes #t (let ([v (edit-view-of b)]) (and v (view-sels v)))))

  (define (buffer-insert! b pos s) (car (buffer-edit! b (list (list pos pos s)))))
  (define (buffer-delete! b s e) (buffer-edit! b (list (list s e ""))))

  (define (buffer-replace-all! b s)
    (buffer-edit! b (list (list 0 (buffer-length b) s))))

  ;; Make s b's text, as what an extension shows rather than an edit: even
  ;; read-only, with no undo, and unmodified after.
  (define (buffer-set-text! b s)
    (let ([ro? (buffer-read-only? b)])
      (buffer-read-only?-set! b #f)
      (apply-changes! b (list (list 0 (buffer-length b) s)) #f #f)
      (buffer-read-only?-set! b ro?)
      (buffer-mark-saved! b)))

  ;; Group the transactions until buffer-end-group! into one undo step.
  (define (buffer-begin-group! b)
    (unless (buffer-group b) (buffer-group-set! b '())))

  (define (buffer-end-group! b)
    (let ([g (buffer-group b)])
      (buffer-group-set! b #f)
      (when (and g (pair? g))
        (buffer-undo-set! b (cons g (buffer-undo b))))))

  ;; The changes that undo a transaction: each recorded (start old new) in
  ;; the coordinates before it, mapped to after it.
  (define (inverse-changes tx-changes)
    (let loop ([l tx-changes] [delta 0] [acc '()])
      (if (null? l)
          (reverse acc)
          (let* ([c (car l)] [s (+ (car c) delta)] [old (cadr c)] [new (caddr c)])
            (loop (cdr l) (+ delta (- (string-length new) (string-length old)))
                  (cons (list s (+ s (string-length new)) old) acc))))))

  (define (forward-changes tx-changes)
    (map (lambda (c) (list (car c) (+ (car c) (string-length (cadr c))) (caddr c))) tx-changes))

  ;; Undo a group (coarse) or a single transaction (fine); returns #f when
  ;; there is nothing to undo.
  (define (buffer-undo! b fine?)
    (buffer-end-group! b)
    (let ([undo (buffer-undo b)])
      (and (pair? undo)
           (let* ([group (car undo)]
                  [txs (if fine? (list (car group)) group)]
                  [rest (if fine? (cdr group) '())])
             (buffer-undo-set! b (if (null? rest) (cdr undo) (cons rest (cdr undo))))
             (for-each
              (lambda (tx)
                (let ([inv (inverse-changes (car tx))])
                  (apply-changes! b inv #f #f)
                  (let ([v (edit-view-of b)])
                    (when (and v (cadr tx)) (view-sels-set! v (clamp-sels b (cadr tx)))))))
              txs)
             (buffer-redo-set! b (cons (reverse txs) (buffer-redo b)))
             #t))))

  (define (buffer-redo! b)
    (let ([redo (buffer-redo b)])
      (and (pair? redo)
           (let ([txs (car redo)])
             (buffer-redo-set! b (cdr redo))
             (for-each
              (lambda (tx)
                ;; What each change put back is selected.
                (let* ([fwd (forward-changes (car tx))] [starts (apply-changes! b fwd #f #f)]
                       [v (edit-view-of b)])
                  (when (and v (pair? fwd))
                    (view-sels-set! v (clamp-sels b (map (lambda (s c) (make-sel s (+ s (string-length (caddr c)))))
                                                         starts fwd))))))
              txs)
             (buffer-undo-set! b (cons (reverse txs) (buffer-undo b)))
             #t))))

  ;; ---------------------------------------------------------------------------
  ;; Files

  (define (utf8-transcoder) (make-transcoder (utf-8-codec) (eol-style none) (error-handling-mode replace)))

  (define (read-file-string path)
    (call-with-port (open-file-input-port path (file-options) (buffer-mode block) (utf8-transcoder))
      (lambda (p) (let ([s (get-string-all p)]) (if (eof-object? s) "" s)))))

  ;; Write atomically: to a temporary beside the file, then rename over it.
  (define (write-file-string path s)
    (let ([tmp (string-append path ".quad-save~")])
      (call-with-port (open-file-output-port tmp (file-options no-fail) (buffer-mode block) (utf8-transcoder))
        (lambda (p) (put-string p s)))
      (when (file-exists? path) (chmod tmp (get-mode path)))
      (rename-file tmp path))))
