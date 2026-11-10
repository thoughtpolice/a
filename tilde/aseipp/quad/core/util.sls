;; util.sls -- small helpers shared by the rest of quad
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad util)
  (export at-load ignore condition->string clamp string-prefix? string-suffix? string-index string-contains
          string-splice string-first-line string-clip
          string-join string-split string-trim-left string-trim-right string-trim
          char-width string-width grapheme-end grapheme-start grapheme-columns
          string-graphemes string-grapheme-before string-grapheme-after fuzzy-score
          list-index take drop filter-map
          bytevector-append bytevector->hex percent-decode
          path-style path-separator? path-anchor absolute-path? path-normalize path->native
          path-join path-parts path-basename path-dirname ancestor-dirs expand-home absolute-path
          getenv-path working-directory home-directory temp-directory user-name
          make-directories! find-executable program-argv
          path->uri-path uri-path->path path->file-uri file-uri->path
          sort-strings sort-symbols macos? windows?)
  (import (chezscheme))

  ;; Chez Scheme allows no definitions after an expression in a library
  ;; body, so expressions run for effect at load time are written as
  ;; (at-load expr ...), a definition of a fresh, unused variable.
  (define-syntax at-load
    (syntax-rules ()
      [(_ e ...) (define ignored (begin e ... #f))]))

  ;; Takes anything and does nothing: a callback for what is not needed.
  ;; (Chez Scheme's void takes nothing.)
  (define (ignore . _) (void))

  ;; What went wrong, as a message: a condition as Chez Scheme displays
  ;; it, anything else raised as display shows it.
  (define (condition->string e)
    (if (condition? e)
        (call-with-string-output-port (lambda (p) (display-condition e p)))
        (format "~a" e)))

  (define (clamp x lo hi) (max lo (min hi x)))

  ;; Whether s has p's characters from `at` on.
  (define (string-at? p s at)
    (let ([n (string-length p)])
      (and (<= 0 at) (<= (+ at n) (string-length s))
           (let loop ([i 0])
             (or (= i n)
                 (and (char=? (string-ref p i) (string-ref s (+ at i))) (loop (+ i 1))))))))

  (define (string-prefix? p s) (string-at? p s 0))

  ;; s up to its first newline.
  (define (string-first-line s)
    (let ([i (string-index s #\newline)]) (if i (substring s 0 i) s)))

  ;; s, at most n characters: past that, its first n - 1 and an ellipsis.
  (define (string-clip s n)
    (if (> (string-length s) n) (string-append (substring s 0 (- n 1)) "…") s))

  ;; s with its characters from start to end replaced by new.
  (define (string-splice s start end new)
    (string-append (substring s 0 start) new (substring s end (string-length s))))

  (define (string-suffix? p s) (string-at? p s (- (string-length s) (string-length p))))

  ;; Whether this is macOS: Chez Scheme's machine types for it end so
  ;; (tarm64osx, ta6osx).
  (define macos? (string-suffix? "osx" (symbol->string (machine-type))))

  ;; Whether this is Windows: Chez Scheme's machine types for it end so
  ;; (ta6nt, tarm64nt).
  (define windows? (string-suffix? "nt" (symbol->string (machine-type))))

  (define string-index
    (case-lambda
     [(s pred) (string-index s pred 0)]
     [(s pred start)
      (let ([n (string-length s)]
            [ok? (if (char? pred) (lambda (c) (char=? c pred)) pred)])
        (let loop ([i start])
          (cond [(>= i n) #f] [(ok? (string-ref s i)) i] [else (loop (+ i 1))])))]))

  ;; The index of the first occurrence of `needle` in `s` at or after
  ;; `start`, or #f.
  (define string-contains
    (case-lambda
     [(s needle) (string-contains s needle 0)]
     [(s needle start)
      (let ([n (string-length s)] [m (string-length needle)])
        (let loop ([i start])
          (cond
           [(> (+ i m) n) #f]
           [(let cmp ([j 0])
              (or (= j m)
                  (and (char=? (string-ref s (+ i j)) (string-ref needle j))
                       (cmp (+ j 1)))))
            i]
           [else (loop (+ i 1))])))]))

  (define (string-join strs sep)
    (if (null? strs)
        ""
        (apply string-append
               (car strs)
               (let loop ([l (cdr strs)])
                 (if (null? l) '() (cons sep (cons (car l) (loop (cdr l)))))))))

  (define (string-split s ch)
    (let ([n (string-length s)])
      (let loop ([i 0] [start 0] [acc '()])
        (cond
         [(= i n) (reverse (cons (substring s start n) acc))]
         [(char=? (string-ref s i) ch)
          (loop (+ i 1) (+ i 1) (cons (substring s start i) acc))]
         [else (loop (+ i 1) start acc)]))))

  (define (string-trim-left s)
    (let ([n (string-length s)])
      (let loop ([i 0])
        (if (and (< i n) (char-whitespace? (string-ref s i)))
            (loop (+ i 1))
            (substring s i n)))))

  (define (string-trim-right s)
    (let loop ([i (string-length s)])
      (if (and (> i 0) (char-whitespace? (string-ref s (- i 1))))
          (loop (- i 1))
          (substring s 0 i))))

  (define (string-trim s) (string-trim-left (string-trim-right s)))


  ;; Terminal columns a character occupies: 0 for combining marks and other
  ;; zero-width code points, 2 for East Asian wide and most emoji, else 1.
  (define (char-width c)
    (let ([n (char->integer c)])
      (cond
       [(< n #x300) 1]
       [(or (<= #x300 n #x36F) (<= #x200B n #x200F) (<= #xFE00 n #xFE0F)
            (<= #x20D0 n #x20FF) (<= #xFE20 n #xFE2F) (<= #x1160 n #x11FF)
            (<= #xE0020 n #xE007F) (<= #xE0100 n #xE01EF))
        0]
       [(or (<= #x1100 n #x115F) (<= #x2E80 n #x303E) (<= #x3041 n #x33FF)
            (<= #x3400 n #x4DBF) (<= #x4E00 n #x9FFF) (<= #xA000 n #xA4CF)
            (<= #xAC00 n #xD7A3) (<= #xF900 n #xFAFF) (<= #xFE30 n #xFE4F)
            (<= #xFF00 n #xFF60) (<= #xFFE0 n #xFFE6)
            (<= #x1F300 n #x1F64F) (<= #x1F900 n #x1F9FF)
            (<= #x1F680 n #x1F6FF) (<= #x1FA70 n #x1FAFF) (<= #x1F200 n #x1F2FF)
            (<= #x20000 n #x3FFFD))
        2]
       [(and (or (<= #x2300 n #x2BFF) (<= #x1F000 n #x1F7FF)) (wide-emoji? n)) 2]
       [else 1])))

  ;; Emoji shown as pictures unless asked otherwise (Unicode's
  ;; Emoji_Presentation), outside the blocks above: terminals give them two
  ;; columns, as East Asian wide characters.
  (define wide-emoji
    '((#x231A . #x231B) (#x23E9 . #x23EC) (#x23F0 . #x23F0) (#x23F3 . #x23F3)
      (#x25FD . #x25FE) (#x2614 . #x2615) (#x2648 . #x2653) (#x267F . #x267F)
      (#x2693 . #x2693) (#x26A1 . #x26A1) (#x26AA . #x26AB) (#x26BD . #x26BE)
      (#x26C4 . #x26C5) (#x26CE . #x26CE) (#x26D4 . #x26D4) (#x26EA . #x26EA)
      (#x26F2 . #x26F3) (#x26F5 . #x26F5) (#x26FA . #x26FA) (#x26FD . #x26FD)
      (#x2705 . #x2705) (#x270A . #x270B) (#x2728 . #x2728) (#x274C . #x274C)
      (#x274E . #x274E) (#x2753 . #x2755) (#x2757 . #x2757) (#x2795 . #x2797)
      (#x27B0 . #x27B0) (#x27BF . #x27BF) (#x2B1B . #x2B1C) (#x2B50 . #x2B50)
      (#x2B55 . #x2B55) (#x1F004 . #x1F004) (#x1F0CF . #x1F0CF) (#x1F18E . #x1F18E)
      (#x1F191 . #x1F19A) (#x1F7E0 . #x1F7EB) (#x1F7F0 . #x1F7F0)))

  (define (wide-emoji? n)
    (exists (lambda (r) (<= (car r) n (cdr r))) wide-emoji))

  ;; ---------------------------------------------------------------------------
  ;; Grapheme clusters: what shows in one place, as one character. The
  ;; editor draws, counts columns, moves and deletes by them, as terminals
  ;; that cluster graphemes (mode 2027: kitty, ghostty, wezterm, foot) draw
  ;; them: a character with the marks, variation selectors, joiners and tags
  ;; after it; an emoji with its skin tone, and those a zero-width joiner
  ;; joins to it (a family, 👨‍👩‍👧); two regional indicators, a flag (🇯🇵).
  ;; Each takes its first character's columns, but two for an emoji asked
  ;; for as a picture (U+FE0F) and for a flag. Clusters are over characters
  ;; (ref i) for indexes up to an end, so that strings and buffer texts
  ;; alike have them; a newline is always a cluster of its own.

  (define (regional-indicator? c) (<= #x1F1E6 (char->integer c) #x1F1FF))

  ;; Whether c continues the cluster whose last character is prev and
  ;; which has `ri` regional indicators.
  (define (extends? prev c ri)
    (let ([n (char->integer c)] [p (char->integer prev)])
      (cond
       [(or (char=? c #\newline) (char=? prev #\newline) (char=? c #\tab)) #f]
       [(= (char-width c) 0) #t]
       ;; After a zero-width joiner, what it joins.
       [(= p #x200D) (> n #x7F)]
       ;; Skin tones, after an emoji.
       [(<= #x1F3FB n #x1F3FF) (> p #x7F)]
       [(regional-indicator? c) (odd? ri)]
       [else #f])))

  ;; The end of the cluster that starts at i, of the characters (ref k)
  ;; for k below end.
  (define (grapheme-end ref i end)
    (if (>= i end)
        i
        (let loop ([j (+ i 1)] [prev (ref i)] [ri (if (regional-indicator? (ref i)) 1 0)])
          (if (>= j end)
              j
              (let ([c (ref j)])
                (if (extends? prev c ri)
                    (loop (+ j 1) c (if (regional-indicator? c) (+ ri 1) ri))
                    j))))))

  ;; The start of the cluster that index i is in, finding clusters from
  ;; the last ASCII character at or before i (a newline, at the furthest):
  ;; one never continues a cluster (extends?), so one begins there.
  (define (grapheme-start ref i)
    (let loop ([c (let back ([k i])
                    (cond [(<= k 0) 0]
                          [(< (char->integer (ref k)) #x80) k]
                          [else (back (- k 1))]))])
      (let ([e (grapheme-end ref c (+ i 1))])
        (if (or (> e i) (= e c)) c (loop e)))))

  ;; The columns the cluster [i, j) takes.
  (define (grapheme-columns ref i j)
    (let ([first (ref i)])
      (let ([w (char-width first)])
        (cond
         [(= w 0) 0]
         [(and (regional-indicator? first) (> (- j i) 1)) 2]
         [(and (= w 1) (let loop ([k (+ i 1)])
                         (and (< k j) (or (char=? (ref k) #\xFE0F) (loop (+ k 1))))))
          2]
         [else w]))))

  ;; The clusters of s, as strings.
  (define (string-graphemes s)
    (let ([ref (lambda (i) (string-ref s i))] [n (string-length s)])
      (let loop ([i 0] [acc '()])
        (if (>= i n)
            (reverse acc)
            (let ([j (grapheme-end ref i n)])
              (loop j (cons (substring s i j) acc)))))))

  ;; Where the cluster before or after index c of string s starts or ends.
  (define (string-grapheme-before s c)
    (if (<= c 0) 0 (grapheme-start (lambda (i) (string-ref s i)) (- c 1))))
  (define (string-grapheme-after s c)
    (grapheme-end (lambda (i) (string-ref s i)) c (string-length s)))

  (define (string-width s)
    (let ([ref (lambda (i) (string-ref s i))] [n (string-length s)])
      (let loop ([i 0] [w 0])
        (if (>= i n)
            w
            (let ([j (grapheme-end ref i n)])
              (loop j (+ w (grapheme-columns ref i j))))))))

  ;; The bytevectors bvs, one after another, in one.
  (define (bytevector-append . bvs)
    (let-values ([(out extract) (open-bytevector-output-port)])
      (for-each (lambda (bv) (put-bytevector out bv)) bvs)
      (extract)))

  (define (hex-digit c) (string->number (string c) 16))

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

  ;; bv's bytes in lowercase hex, two digits each.
  (define (bytevector->hex bv)
    (string-downcase
     (apply string-append
            (map (lambda (b) (string-append (if (< b 16) "0" "") (number->string b 16)))
                 (bytevector->u8-list bv)))))

  ;; Score `candidate` against `pattern` as a case-insensitive subsequence
  ;; match: #f if it does not match, else (score . matched-indices) where a
  ;; higher score is better. Consecutive matches and matches at word starts
  ;; score higher; shorter candidates win ties.
  (define (fuzzy-score pattern candidate)
    (let ([pn (string-length pattern)] [cn (string-length candidate)])
      (let loop ([pi 0] [ci 0] [score 0] [prev -2] [hits '()])
        (cond
         [(= pi pn) (cons (- score (* cn 0.01)) (reverse hits))]
         [(= ci cn) #f]
         [(char-ci=? (string-ref pattern pi) (string-ref candidate ci))
          (let* ([boundary? (or (= ci 0)
                                (memv (string-ref candidate (- ci 1)) '(#\/ #\- #\_ #\. #\space)))]
                 [bonus (+ 1 (if (= prev (- ci 1)) 5 0) (if boundary? 3 0))])
            (loop (+ pi 1) (+ ci 1) (+ score bonus) ci (cons ci hits)))]
         [else (loop pi (+ ci 1) score prev hits)]))))

  (define (list-index pred l)
    (let loop ([l l] [i 0])
      (cond [(null? l) #f] [(pred (car l)) i] [else (loop (cdr l) (+ i 1))])))

  (define (take l n) (if (or (= n 0) (null? l)) '() (cons (car l) (take (cdr l) (- n 1)))))
  (define (drop l n) (if (or (= n 0) (null? l)) l (drop (cdr l) (- n 1))))

  (define (filter-map f l)
    (let loop ([l l])
      (if (null? l)
          '()
          (let ([v (f (car l))]) (if v (cons v (loop (cdr l))) (loop (cdr l)))))))

  ;; ---------------------------------------------------------------------------
  ;; Paths
  ;;
  ;; A path is a string, as Chez Scheme's file procedures take it. On Unix,
  ;; / separates its parts, and it is absolute when it starts with one. On
  ;; Windows, / or \ separates them, and its root is a drive's ("C:/"), a
  ;; share's ("//server/share/"), the current drive's ("/"), or a drive's
  ;; working directory ("C:"). There, the paths quad makes are spelled with
  ;; /, as Emacs spells them (path-normalize): every Windows file procedure
  ;; takes them, and one spelling of each path is what lets paths be
  ;; compared as strings (a buffer's, a project's, a server's root). Only
  ;; what other programs are given is spelled with \ (path->native).
  ;;
  ;; Which of these rules apply is (path-style): 'windows on Windows, else
  ;; 'unix. Tests set it, to check the other's rules on any host.

  (define path-style
    (make-parameter (if windows? 'windows 'unix)
                    (lambda (s)
                      (unless (memq s '(unix windows)) (errorf 'path-style "unknown path style ~s" s))
                      s)))

  (define (windows-paths?) (eq? (path-style) 'windows))

  (define (path-separator? c)
    (or (char=? c #\/) (and (char=? c #\\) (windows-paths?))))

  (define (drive-letter? c) (or (char<=? #\a c #\z) (char<=? #\A c #\Z)))

  ;; Whether p starts with a drive ("C:").
  (define (drive? p)
    (and (>= (string-length p) 2) (drive-letter? (string-ref p 0)) (char=? (string-ref p 1) #\:)))

  ;; How many of p's characters are its root (0 for a relative path): on
  ;; Unix, its leading /; on Windows, a drive and the separator after it, a
  ;; share's //server/share and the separator after that, or a lone
  ;; separator.
  (define (path-root-length p)
    (let* ([n (string-length p)]
           [sep? (lambda (i) (and (< i n) (path-separator? (string-ref p i))))])
      (cond
       [(not (windows-paths?)) (if (sep? 0) 1 0)]
       [(drive? p) (if (sep? 2) 3 2)]
       [(and (sep? 0) (sep? 1))
        (let* ([server-end (or (string-index p path-separator? 2) n)]
               [share-end (if (< server-end n) (or (string-index p path-separator? (+ server-end 1)) n) n)])
          (min n (+ share-end 1)))]
       [(sep? 0) 1]
       [else 0])))

  ;; p's root, as path-root-length has it: "" for a relative path.
  (define (path-anchor p) (substring p 0 (path-root-length p)))

  ;; Whether p names the same file from any working directory: on Unix, it
  ;; starts with /; on Windows, it starts with a drive and a separator, or
  ;; names a share. ("/x" is on the current drive, and "C:x" in drive C's
  ;; working directory, so neither is.)
  (define (absolute-path? p)
    (if (windows-paths?)
        (let ([n (string-length p)])
          (or (and (drive? p) (> n 2) (path-separator? (string-ref p 2)))
              (and (>= n 2) (path-separator? (string-ref p 0)) (path-separator? (string-ref p 1)))))
        (string-prefix? "/" p)))

  ;; p in quad's spelling: on Windows, with / for \ and its drive's letter
  ;; in capitals; elsewhere, p.
  (define (path-normalize p)
    (if (windows-paths?)
        (let ([s (list->string (map (lambda (c) (if (char=? c #\\) #\/ c)) (string->list p)))])
          (when (drive? s) (string-set! s 0 (char-upcase (string-ref s 0))))
          s)
        p))

  ;; p spelled as the system's own programs expect it: on Windows, with \.
  (define (path->native p)
    (if (windows-paths?)
        (list->string (map (lambda (c) (if (char=? c #\/) #\\ c)) (string->list p)))
        p))

  ;; Environment variable var's path, in quad's spelling, or #f.
  (define (getenv-path var)
    (let ([v (getenv var)]) (and v (path-normalize v))))

  ;; The working directory, in quad's spelling.
  (define (working-directory) (path-normalize (current-directory)))

  ;; The user's home directory, or #f: $HOME, else on Windows %USERPROFILE%.
  (define (home-directory)
    (or (getenv-path "HOME") (and (windows-paths?) (getenv-path "USERPROFILE"))))

  ;; Where temporary files go: $TMPDIR, else /tmp; on Windows %TEMP%, else
  ;; %TMP%, else the system's.
  (define (temp-directory)
    (if (windows-paths?)
        (or (getenv-path "TEMP") (getenv-path "TMP")
            (let ([root (getenv-path "SystemRoot")]) (and root (path-join root "Temp")))
            "C:/Windows/Temp")
        (or (getenv "TMPDIR") "/tmp")))

  ;; The user's login name, or #f: $USER, else on Windows %USERNAME%.
  (define (user-name)
    (or (getenv "USER") (and (windows-paths?) (getenv "USERNAME"))))

  (define (path-join a b)
    (cond
     [(string=? a "") b]
     [(path-separator? (string-ref a (- (string-length a) 1))) (string-append a b)]
     [else (string-append a "/" b)]))

  ;; p's parts, between its separators.
  (define (path-parts p)
    (let ([n (string-length p)])
      (let loop ([i n] [end n] [acc '()])
        (cond
         [(= i 0) (cons (substring p 0 end) acc)]
         [(path-separator? (string-ref p (- i 1))) (loop (- i 1) (- i 1) (cons (substring p i end) acc))]
         [else (loop (- i 1) end acc)]))))

  ;; What follows p's last separator, past its root.
  (define (path-basename p)
    (let ([root (path-root-length p)])
      (let loop ([i (string-length p)])
        (cond [(<= i root) (substring p root (string-length p))]
              [(path-separator? (string-ref p (- i 1))) (substring p i (string-length p))]
              [else (loop (- i 1))]))))

  ;; What is before p's last separator, or its root: "." if it has
  ;; neither. A root is its own (so walking up stops there).
  (define (path-dirname p)
    (let ([root (path-root-length p)])
      (let loop ([i (string-length p)])
        (cond [(<= i root) (if (= root 0) "." (substring p 0 root))]
              [(path-separator? (string-ref p (- i 1))) (substring p 0 (- i 1))]
              [else (loop (- i 1))]))))

  ;; dir, then the directories it is in, out to the last.
  (define (ancestor-dirs dir)
    (let loop ([d dir] [acc '()])
      (let ([up (path-dirname d)])
        (if (string=? up d) (reverse (cons d acc)) (loop up (cons d acc))))))

  ;; ~/x as x in the home directory (~\x too, on Windows).
  (define (expand-home p)
    (let ([home (and (>= (string-length p) 2) (char=? (string-ref p 0) #\~) (path-separator? (string-ref p 1))
                     (home-directory))])
      (if home (path-join home (substring p 2 (string-length p))) p)))

  ;; p, from directory dir (default: the working directory) if it is
  ;; relative. On Windows the result is in quad's spelling; a path on the
  ;; current drive ("/x") is on dir's, and one in a drive's working
  ;; directory ("D:x") in dir if dir is on that drive, else at the drive's
  ;; root (which working directory Windows keeps for another drive, Chez
  ;; Scheme does not say).
  (define absolute-path
    (case-lambda
     [(p) (absolute-path* p #f)]
     [(p dir) (absolute-path* p dir)]))

  (define (absolute-path* p dir)
    (let ([dir (lambda () (if dir (path-normalize dir) (working-directory)))])
      (if (windows-paths?)
          (let ([p (path-normalize p)])
            (cond
             [(absolute-path? p) p]
             [(drive? p)
              (let ([d (dir)] [rest (substring p 2 (string-length p))])
                (if (and (drive? d) (char-ci=? (string-ref d 0) (string-ref p 0)))
                    (path-join d rest)
                    (string-append (substring p 0 2) "/" rest)))]
             [(string-prefix? "/" p)
              (let ([root (path-anchor (dir))])
                (string-append (if (string-suffix? "/" root) (substring root 0 (- (string-length root) 1)) root) p))]
             [else (path-join (dir) p)]))
          (if (string-prefix? "/" p) p (path-join (dir) p)))))

  ;; Makes directory dir, and those it is in, unless they exist.
  (define (make-directories! dir)
    (unless (or (string=? dir "") (file-exists? dir))
      (make-directories! (path-dirname dir))
      (mkdir dir)))

  ;; Where program is: itself, if it names a directory, else the first
  ;; file of that name in a directory of PATH; or #f.
  ;;
  ;; On Windows, as its shell finds programs: PATH's directories are
  ;; separated by ;, and a program is a file with an extension of PATHEXT's
  ;; (.exe, .cmd, ...), which program may leave off (npm's shims, "codex"
  ;; among them, are codex.cmd).
  (define (find-executable program)
    (if (windows-paths?)
        (let* ([exts (map string-downcase
                          (filter (lambda (e) (not (string=? e "")))
                                  (string-split (or (getenv "PATHEXT") ".COM;.EXE;.BAT;.CMD") #\;)))]
               [names (if (exists (lambda (e) (string-suffix? e (string-downcase program))) exts)
                          (list program)
                          (map (lambda (e) (string-append program e)) exts))]
               [file (lambda (f) (and (file-exists? f) (not (file-directory? f)) (path-normalize f)))])
          (if (or (string-index program path-separator?) (drive? program))
              (exists file names)
              (exists (lambda (dir) (exists (lambda (n) (file (path-join dir n))) names))
                      (filter-map (lambda (dir)
                                    (let ([dir (string-trim dir)])
                                      (cond
                                       [(string=? dir "") #f]
                                       [(and (>= (string-length dir) 2) (string-prefix? "\"" dir) (string-suffix? "\"" dir))
                                        (substring dir 1 (- (string-length dir) 1))]
                                       [else dir])))
                                  (string-split (or (getenv "PATH") "") #\;)))))
        (if (string-index program #\/)
            (and (file-exists? program) program)
            (exists (lambda (dir)
                      (let ([f (path-join (if (string=? dir "") "." dir) program)])
                        (and (file-exists? f) (not (file-directory? f)) f)))
                    (string-split (or (getenv "PATH") "") #\:)))))

  ;; argv, to run (with spawn-process and its kin, the Rust half's), with
  ;; its program found as find-executable finds it: on Windows, the Rust
  ;; half finds only .exe files in PATH by itself, and runs a .cmd or .bat
  ;; file (through cmd.exe, its arguments escaped for it) only when given
  ;; its path. Elsewhere, argv.
  (define (program-argv argv)
    (if (and (windows-paths?) (pair? argv))
        (let ([found (find-executable (car argv))])
          (if found (cons (path->native found) (cdr argv)) argv))
        argv))

  ;; ---------------------------------------------------------------------------
  ;; file: URIs

  ;; What follows "file://" in the URI for absolute path p, before
  ;; percent-encoding: on Unix, p; on Windows, "/C:/dir/file" for a drive's
  ;; path, "server/share/file" for a share's.
  (define (path->uri-path p)
    (if (windows-paths?)
        (let ([p (path-normalize p)])
          (cond
           [(string-prefix? "//" p) (substring p 2 (string-length p))]
           [(drive? p) (string-append "/" p)]
           [else p]))
        p))

  ;; The path that what follows "file://" in a URI (percent-encoded) names:
  ;; on Unix, its path; on Windows, a drive's path without the / before it
  ;; ("/c:/x", "/C%3A/x": "C:/x"), and another host's a share ("//host/x").
  (define (uri-path->path s)
    (let ([s (percent-decode s)])
      (if (windows-paths?)
          (let ([s (if (string-prefix? "localhost/" s) (substring s 9 (string-length s)) s)])
            (cond
             [(and (string-prefix? "/" s) (drive? (substring s 1 (string-length s))))
              (path-normalize (substring s 1 (string-length s)))]
             [(string-prefix? "/" s) (path-normalize s)]
             [else (path-normalize (string-append "//" s))]))
          s)))

  (define (uri-unreserved? c)
    (or (char<=? #\a c #\z) (char<=? #\A c #\Z) (char<=? #\0 c #\9) (memv c '(#\- #\. #\_ #\~ #\/))))

  (define (percent-encode s)
    (apply string-append
           (map (lambda (c)
                  (if (uri-unreserved? c)
                      (string c)
                      (apply string-append
                             (map (lambda (b) (string-append "%" (if (< b 16) "0" "") (string-upcase (number->string b 16))))
                                  (bytevector->u8-list (string->utf8 (string c)))))))
                (string->list s))))

  ;; Absolute path p as a file: URI, percent-encoded but for a drive's
  ;; colon ("file:///C:/a%20b").
  (define (path->file-uri p)
    (let ([u (path->uri-path p)])
      (string-append
       "file://"
       (if (and (windows-paths?) (string-prefix? "/" u) (drive? (substring u 1 (string-length u))))
           (string-append (substring u 0 3) (percent-encode (substring u 3 (string-length u))))
           (percent-encode u)))))

  ;; The path a file: URI names (anything else is percent-decoded as it is).
  (define (file-uri->path uri)
    (uri-path->path (if (string-prefix? "file://" uri) (substring uri 7 (string-length uri)) uri)))

  (define (sort-strings l) (sort string<? l))
  (define (sort-symbols l) (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) l)))
