<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# The quad tutor, with Vim's keys

Welcome. quad is using Vim's keys, and this tutor teaches them as quad has
them. It is a buffer like any other: a fresh copy, for you to work through
by editing it. Nothing you do here touches a file unless you save it, and
`space k h` (or `quad --tutor`) brings back a clean copy.

Each lesson explains a few keys, then gives you lines to practise on. They
are indented, with what they should become underneath, marked ✓:

    Edit lines like this one.
  ✓ Until they look like this one.

Keys are written like `x`. Keys apart, like `d w`, are pressed one after the
other. If you know Vim already, skim: most of it is what you expect, and
lessons 9 and 10 are about quad itself.


# Lesson 1: moving

In *normal mode*, where you are now, keys are commands, not text. The
cursor moves with `h` `j` `k` `l`:

            k
          h   l        h left, j down, k up, l right
            j

The arrow keys and the mouse work too.

  1. Press `j` a few times to move down, and `k` to move back up.
  2. Press `l` and `h` to move along a line.
  3. Keep pressing `j` until you reach Lesson 1.1.

`ctrl+d` and `ctrl+u` scroll half a page down and up.


## Lesson 1.1: by words and lines

  `w`  the next word's start         `b`  back to a word's start
  `e`  the end of the word           `W` `B` `E`  the same, by WORDs
  `0`  the start of the line         `^`  its first non-blank
  `$`  the end of the line           `gg` `G`  the first and last line

A WORD runs to the next space, punctuation and all; a word stops at it.
Most motions take a count first: `3w` goes three words on, `5j` five lines
down, `12G` to line 12.

  1. Move along the line below with `w`, then `b`, then `e`; try `W`.

    one two, three-four five.six (seven) eight

  2. Press `$` and `0` on it; then `3w`.


## Lesson 1.2: leaving

`:q` then `enter` quits; quad asks first if a file has unsaved changes,
and `:q!` quits anyway. Don't quit now; but when you do, `quad --tutor`
starts the tutor again, and `space k h` opens it from inside the editor.

The bottom line is the *status line*: it says `NOR` in normal mode.


## Lesson 1 summary

  - `h` `j` `k` `l` move; `w` `b` `e` by words; `0` `^` `$` on the line.
  - `gg` and `G` go to the first and last lines; a count goes further.
  - `:q` quits, `:q!` without saving; `space k h` opens the tutor.


# Lesson 2: deleting

`x` deletes the character under the cursor.

  1. On the line below, put the cursor on each doubled letter and press
     `x` to delete one of them.

    The ccow jumpedd over thhe moon.
  ✓ The cow jumped over the moon.

`d` is an *operator*: it deletes what the motion after it moves over. `d
w` deletes to the next word's start (the word and the space after it), `d
$` to the end of the line, `d d` the whole line.

  2. Put the cursor on the second "the" of each pair below and press `d`
     `w`.

    The cat the the sat on the the mat.
  ✓ The cat the sat on the mat.

  3. Delete the line in the middle: move to it and press `d` `d`.

    Keep this line.
    Delete this line.
    Keep this line too.
  ✓ Keep this line.
  ✓ Keep this line too.

A count goes before the operator, or before the motion: `d 2 w` and `2 d
w` both delete two words, and `3 d d` three lines.

  4. On "red" below, press `d` `2` `w`.

    a red blue sky
  ✓ a sky

`D` deletes to the end of the line, like `d $`.


## Lesson 2.1: undo

`u` undoes, and `ctrl+r` redoes. Undo the last deletion with `u`, and
bring it back with `ctrl+r`.


## Lesson 2 summary

  - `x` deletes a character; `d` and a motion delete what it moves over.
  - `dw` a word, `d$` (or `D`) the rest of the line, `dd` the line.
  - A count: `2dw`, `3dd`; `u` undoes, `ctrl+r` redoes.


# Lesson 3: inserting

`i` starts *insert mode* before the cursor; `a` after it. Type, then press
`esc` to go back to normal mode. The status line says `INS` while you
insert.

  1. On the line below, put the cursor on the "e" of "editor", press `i`,
     type "an " (with the space), and press `esc`.

    quad is editor.
  ✓ quad is an editor.

`A` appends at the end of the line, and `I` inserts before its first
non-blank.

  2. On the line below, press `A`, type "!", and press `esc`.

    Hello, world
  ✓ Hello, world!

`o` opens a new line below the cursor's, in insert mode, and `O` one above.

  3. On "first" below, press `o`, type "second", and press `esc`.

    first
    third
  ✓ first
  ✓ second
  ✓ third


## Lesson 3 summary

  - `i` inserts before the cursor, `a` after it; `esc` ends inserting.
  - `A` at the line's end, `I` at its start; `o` `O` open a line.


# Lesson 4: changing

`c` is the operator that changes: it deletes what its motion moves over,
then starts inserting there. `c w` changes to the end of the word, `c $`
(or `C`) to the end of the line, `c c` the whole line.

  1. On "green" below, press `c` `w`, type "blue", and press `esc`.

    The sky is green.
  ✓ The sky is blue.

  2. On "is" below, press `C`, type "was fixed.", and press `esc`.

    This line is wrong in its second half.
  ✓ This line was fixed.

`r` and a character replaces the character under the cursor; `~` switches
its case and moves on. `s` deletes the character and inserts.

  3. Fix the two wrong letters below with `r`: on the "x", press `r` `i`;
     on the "P", press `r` `p`.

    Wxth a tyPo
  ✓ With a typo


## Lesson 4 summary

  - `c` and a motion change: `cw`, `C` (or `c$`), `cc`.
  - `r` replaces a character, `~` switches case, `s` substitutes.


# Lesson 5: text objects

After an operator, `i` or `a` and a letter name an *object* around the
cursor: `iw` the word it is on (`aw` with the space after), `i(` inside
the parentheses it is in (`a(` with them), and the same with `[` `{` `<`,
quotes (`i"` `i'`), and `ip` a paragraph. Unlike a motion, an object does
not care where in it the cursor is.

  1. Put the cursor anywhere in "wrong, args" below, press `c` `i` `(`,
     type "right", and press `esc`.

    call(wrong, args)
  ✓ call(right)

  2. Put the cursor on any letter of "delete" below and press `d` `a`
     `w`.

    please delete this
  ✓ please this

  3. Put the cursor inside the quotes below and press `d` `i` `"`.

    say "nothing at all" now
  ✓ say "" now


## Lesson 5 summary

  - `i` and `a` after an operator take an object: `iw` `aw`, `i(` `a(`,
    `i"`, `ip` and the other pairs.


# Lesson 6: copying and pasting

`y` is the operator that copies (*yanks*): `y w` a word, `y y` (or `Y`) the
line. `p` puts what was yanked after the cursor, `P` before it; lines go
below and above. Deleting yanks too, so `d d` then `p` moves a line.

  1. On "one" below, press `y` `w`, then `w` (to "two"), then `P`.

    one two three
  ✓ one one two three

  2. Put these lines in order: on "2. second", press `d` `d` (the cursor
     goes to "1. first"), then `p` to put it below.

    2. second
    1. first
    3. third
  ✓ 1. first
  ✓ 2. second
  ✓ 3. third


## Lesson 6.1: registers

Yanks and deletes go to the *unnamed register*, which is also quad's
clipboard (and your system's, in terminals that allow it). `"` and a
letter before an operator or a put use a register of that name instead:
`" a y y` yanks a line into register a, and `" a p` puts it, whatever was
yanked since. `" A y y` adds to register a. `"0` has the last yank, `"1`
to `"9` the last lines deleted, and `"_` throws away what goes into it.
`:reg` shows them all.

  1. On "keep me" below, press `" k y y`. Then `j` `d d` deletes "drop
     me"; go back up with `k` and press `" k p`: the line you kept, not
     the one you deleted.

    keep me
    drop me
  ✓ keep me
  ✓ keep me


## Lesson 6 summary

  - `y` and a motion yank: `yw`, `yy` (or `Y`); `p` `P` put after, before.
  - `"a` before a yank, delete or put uses register a; `:reg` lists them.


# Lesson 7: visual mode

`v` starts *visual mode*: motions then extend a selection from where it
started, and an operator acts on it. `V` selects whole lines. `o` jumps to
the selection's other end, and `esc` (or `v` again) leaves.

  1. On "one" below, press `v`, then `e` `e` (to the end of "two") and `l`
     (onto the space), then `d`.

    one two three four
  ✓ three four

  2. On "alpha" below, press `V` `j` `d`: two lines go.

    alpha
    beta
    gamma
  ✓ gamma

In visual mode, an object selects itself: `v i w` selects the word, `v i (`
inside the parentheses. `U` and `u` change what is selected to upper and
lower case, and `>` `<` indent and dedent.

  3. Put the cursor on "loud" below and press `v` `i` `w` `U`.

    make this loud
  ✓ make this LOUD


## Lesson 7 summary

  - `v` selects by characters, `V` by lines; an operator acts on it.
  - `o` swaps ends; `iw` `i(`... select objects; `U` `u` `>` `<`.


# Lesson 8: finding things

`/` searches forward: type what you are looking for (a regular
expression) and press `enter`. `?` searches backward. `n` goes to the next
match, `N` the one before. `*` and `#` search for the word under the
cursor.

  1. Press `/`, type "needle", and press `enter`. Then `n` for the next
     one, and `N` to come back.

    hay hay hay needle hay hay hay hay needle hay

`f` and a character goes to that character, along the line; `t` to just
before it; `F` and `T` look backward. `;` repeats the last of them, and
`,` repeats it backward. `%` goes to the bracket that matches the one
under the cursor.

  2. On the line below, press `f` `,` and then `;` twice to hop between
     the commas.

    one, two, three, four

`:` and a number go to that line: `:1` then `enter` goes to the top.
(Come back with `G`, or a search.) `H` `M` `L` go to the top, middle and
bottom of the screen, and `z z` puts the cursor's line in the middle.


## Lesson 8 summary

  - `/` `?` search; `n` `N` next and previous; `*` `#` the word here.
  - `f` `t` `F` `T` a character, `;` `,` again; `%` the matching bracket.
  - `:N` goes to line N; `H` `M` `L` on the screen; `zz` centers.


# Lesson 9: repeating

`.` repeats the last change: an operator with its motion, a put, or an
insert with everything typed in it. With a count, `3 .` repeats it with
that count instead.

  1. On "x = 1" below, press `A`, type ";", and press `esc`. Then `j` `.`
     and `j` `.` for the other two lines.

    x = 1
    y = 2
    z = 3
  ✓ x = 1;
  ✓ y = 2;
  ✓ z = 3;

  2. On the first "very" below, press `d` `w`, then `.` twice.

    a very very very long line
  ✓ a long line


## Lesson 9.1: macros

A *macro* is keys recorded to play back. `q` and a letter starts recording
into that register (the status line says `recording @a`); `q` stops. `@`
and the letter plays it, `@ @` plays the last one again, and a count plays
it that many times.

  1. On "apple" below, press `q` `a` to record; then `I`, type "- ", press
     `esc`, `j` to go down, and `q` to stop. Then `2 @ a` does the other
     two lines.

    apple
    banana
    cherry
  ✓ - apple
  ✓ - banana
  ✓ - cherry


## Lesson 9 summary

  - `.` repeats the last change; `3.` with a count of its own.
  - `qa` ... `q` records a macro; `@a` plays it, `@@` again, `2@a` twice.


# Lesson 10: files, buffers, and quad

  `:w`         saves (`:w FILE` saves to that file)
  `:e FILE`    opens a file
  `:bn` `:bp`  go to the next and previous buffer; `:bd` closes one
  `:sp` `:vs`  split the window below and to the right

This tutor is not a file yet: `:w` asks where to save it. Press `esc` to
say no, or give it a name.

`space` opens quad's menu, the same with every key scheme. After it, the
keys you can press next appear:

  `space k d`      opens a file from the working directory, by fuzzy search
  `space k f`      switches to a buffer by name
  `space ;`        browses the file system
  `space /`        lists every key binding
  `space space`    runs any command by name (try it: type "tutor")
  `space j s`      picks the keys: Vim's, Helix's, or quad's own (Ki's)
  `ctrl+w`         works with panes: splitting, moving between them

quad is written in Chez Scheme, and all of it can be changed while it
runs. `space e` evaluates Scheme: press it, type the line below, and press
`enter`.

    (message "Hello from ~a" (scheme-version))

Your configuration is a Scheme file, `~/.config/quad/init.ss`, loaded at
start. `(set-var! 'key-scheme 'vim)` there keeps Vim's keys; it can define
commands, bind keys, change colours and add modes too: quad's README shows
how, and its `docs/examples/init.ss` has more.


## Lesson 10 summary

  - `:w` saves, `:e` opens; `:bn` `:bp` `:bd` buffers; `:sp` `:vs` split.
  - `space` is quad's menu; `space /` lists the keys; `space e` evaluates.
  - `~/.config/quad/init.ss` is yours to change.

That is the tutor. Quit with `:q`, or keep practising here.
