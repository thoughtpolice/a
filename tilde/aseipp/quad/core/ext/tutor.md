<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# The quad tutor

Welcome. This is a buffer like any other: a fresh copy of the tutor, for you
to work through by editing it. Nothing you do here touches a file unless you
save it, and `space k h` (or `quad --tutor`) brings back a clean copy.

Each lesson explains a few keys, then gives you lines to practise on. They
are indented, with what they should become underneath, marked ✓:

    Edit lines like this one.
  ✓ Until they look like this one.

Keys are written like `s`. Two keys apart, like `s l`, are pressed one after
the other. Read a lesson, then do its exercises; it takes about half an
hour.


# Lesson 1: moving

quad is a modal editor: in *normal mode*, where you are now, keys are
commands, not text. Moving is `i` `j` `k` `l`, laid out like arrow keys:

            i
          j k l        i up, k down, j left, l right

The arrow keys work too, and so does the mouse: click to select, scroll
with the wheel.

  1. Press `k` a few times to move down, and `i` to move back up.
  2. Press `l` and `j` to move right and left.
  3. Keep pressing `k` until you reach Lesson 1.1.

`alt+k` and `alt+i` (or page down and page up) scroll half a page at once.


## Lesson 1.1: leaving, and coming back

`space j v` quits (so does `ctrl+q`). quad asks first if a file has
unsaved changes. Don't quit now; but when you do, `quad --tutor` starts
the tutor again, and `space k h` opens it from inside the editor.

Look at the bottom of the screen: the *status line*. It says `NOR` (normal
mode) and `CHAR`, the selection mode. That is the next lesson.


## Lesson 1 summary

  - `i` `j` `k` `l` move up, left, down, right; `alt+k` `alt+i` scroll.
  - `space j v` quits; `quad --tutor` or `space k h` opens the tutor.


# Lesson 2: selection modes

There is no plain cursor in quad: there is always a *selection*, and the
*selection mode* says what it selects. In `CHAR` mode it is one character,
so the movements you just learned go a character or a line at a time.
Change the mode, and the same keys move by other units:

    `s`  WORD        words
    `a`  LINE        lines
    `W`  CHAR        characters
    `w`  SUBWORD     the parts of fooBar_baz: foo, Bar, baz
    `E`  PARAGRAPH   runs of lines between blank lines
    `d`  NODE        structure: brackets, and s-expressions in Lisp

`j` and `l` go to the previous and next unit, `i` and `k` to the one above
and below, `y` and `p` to the first and last (of the line's words, or of
the buffer's lines).

  1. Move to the line below and press `s`. A whole word is selected, and
     the status line says `WORD`.
  2. Press `l` a few times: word by word. `j` goes back. `p` jumps to the
     last word, `y` to the first.
  3. Press `a`: now the whole line is selected, and `k` and `i` move by
     lines. Press `W` to go back to single characters.

    Move through these words one at a time, then back again.

  4. Press `w` on the line below and step through it with `l`.

    parseHttpRequest read_config_file XMLHttpRequest

`u` and `o` are like `j` and `l`, but stop at every unit, punctuation too.
`tab` and `backspace` step forward and back through the selections you
have had.


## Lesson 2 summary

  - A selection mode says what a movement moves over: `s` words, `a`
    lines, `W` characters, `w` subwords, `E` paragraphs, `d` nodes.
  - `j` `l` previous and next, `i` `k` above and below, `y` `p` first and
    last on the line.


# Lesson 3: deleting and undoing

Editing works on the selection: select something, then say what to do
with it. `r` deletes. Deleting a word takes the space after it too, and
selects the next word.

`r` is a *layer* key, like several to come: tapped alone it does one thing
(delete), and held, it changes what other keys do. If tapping `r` seems to
do nothing, your terminal can't tell quad when a key is released (only
some terminals can, with the kitty keyboard protocol): press `r` a second
time. Do the same for every layer key, in every lesson.

  1. On the line below, press `s` `y` to select its first word, then `l`
     to select the second "the".
  2. Tap `r`. Then do the same to the second doubled "the".

    The the cat sat on the the mat.
  ✓ The cat sat on the mat.

  3. Delete the line in the middle: move to it, press `a`, tap `r`.

    Keep this line.
    Delete this line.
    Keep this line too.
  ✓ Keep this line.
  ✓ Keep this line too.

`z` (tapped) undoes, and `Z` redoes. Undo the last deletion with `z`, redo
it with `Z`. Held, `z` has finer steps: `z u` and `z o` undo and redo a
little at a time.


## Lesson 3 summary

  - `r` deletes the selection.
  - `z` undoes, `Z` redoes.
  - A layer key's tap does one thing; if a tap does nothing, press it again.


# Lesson 4: inserting text

`h` starts *insert mode* before the selection, `;` after it. Type, then
press `esc` to go back to normal mode. The status line says `INS` while
you insert. In insert mode, `enter`, `backspace`, the arrows and `ctrl+w`
(delete a word) do what you would expect.

  1. On the line below, press `s` `y`, then `l` `l` to select "editor".
  2. Press `h`, type "an " (with the space), and press `esc`.

    quad is editor.
  ✓ quad is an editor.

  3. Add an exclamation mark at the end: `s` `p` selects the line's last
     word, "world", and `;` inserts after it.

    Hello, world
  ✓ Hello, world!


## Lesson 4.1: changing

`g` (tapped) *changes* the selection: it deletes it and starts inserting in
its place.

  1. Select "green" below (`s` `y`, then `l` `l` `l`), tap `g`, type "blue",
     and press `esc`.

    The sky is green.
  ✓ The sky is blue.


## Lesson 4.2: opening lines

Held, `g` opens space for new text: `g k` opens a line below the selection
and `g i` one above, both in insert mode, indented like their neighbour.

  1. Move to "first" below, press `a`, then `g` `k`, type "second", and
     press `esc`.

    first
    third
  ✓ first
  ✓ second
  ✓ third


## Lesson 4 summary

  - `h` inserts before the selection, `;` after; `esc` ends inserting.
  - `g` changes the selection; `g k` and `g i` open a line below and above.


# Lesson 5: copying, cutting, pasting

  `c`  copies the selection
  `x`  cuts it
  `v`  replaces it with what you copied or cut
  `v l` pastes after it, `v j` before, with the gap units need between
       them (a space between words, a newline between lines)
  `v k` pastes on a new line below, `v i` above

These are layers too: tapping does the first thing in each row.

  1. On the line below, press `s` `y` to select "one" and tap `c`.
  2. Press `l` (on "two") and press `v` `l`: "one" again, after it.

    one two three
  ✓ one two one three

  3. Put these lines in order: select "2. second" (`a`), tap `x` to cut it
     (the next line is selected), then press `v` `k` to paste it below.

    2. second
    1. first
    3. third
  ✓ 1. first
  ✓ 2. second
  ✓ 3. third

Held, `c` duplicates: `c k` copies the selection onto a new line below, `c
l` after it. Copying also sets your system clipboard (in terminals that
allow it); `space v` pastes from the system clipboard, and `v y` and `v p`
step back and forth through what you copied before.


## Lesson 5 summary

  - `c` copies, `x` cuts, `v` replaces with the clipboard.
  - `v l` `v j` paste after and before; `v k` `v i` below and above.
  - `c k` duplicates below; `space v` pastes the system clipboard.


# Lesson 6: more than one selection

## Lesson 6.1: extending

`f` makes the following movements *extend* the selection instead of moving
it; the status line says `EXT`. `esc` stops extending. `f` `f` selects
everything.

  1. On the line below, press `s` `y` (on "one"), then `f` `l` `l`: the
     selection grows to "one two three". Tap `r`.

    one two three four
  ✓ four


## Lesson 6.2: many cursors

`b` adds selections: held, `b l` adds one at the next unit, `b k` one
below, and so on. `n` `n` puts a selection on every occurrence of the
current one. Whatever you do then happens at all of them. `esc` goes back
to one selection.

  1. On the line below, press `s` `y` (on "cat"), then `n` `n`: every "cat"
     is selected.
  2. Tap `g`, type "cow", and press `esc` twice (once to stop inserting,
     once to go back to one selection).

    cat dog cat bird cat
  ✓ cow dog cow bird cow


## Lesson 6.3: swapping

`t` swaps the selection with a neighbour: `t l` with the next unit, `t j`
the previous, `t k` the one below. It is a layer with no tap.

  1. On the line below, press `s` `y` (on "brown"), then `t` `l`.

    brown quick fox
  ✓ quick brown fox


## Lesson 6 summary

  - `f` extends with the following movements; `f f` selects all.
  - `b l` `b k`... add a selection; `n n` selects every occurrence.
  - `t l` `t j`... swap with a neighbour; `esc` goes back to one selection.


# Lesson 7: finding things

`n` `d` searches: type what you are looking for and press `enter`. The
first match after the selection is selected, and the selection mode is
now `SEARCH`, so `l` and `j` go to the next and previous match.

  1. Press `n` `d`, type "needle", press `enter`.
  2. Press `l` to go to the next needle and `j` to come back.

    hay hay hay needle hay hay hay hay needle hay

`n` `f` searches for the selected text, and `n` `r` repeats the last search.

`m` *jumps*: every word on the screen gets a letter, and typing a letter
selects its word. Try it: press `m`, then a letter you see.

`M` goes to a line by its number: press `M`, type "1", press `enter` to go
to the top. (Then come back here with `alt+k`, or a search.)


## Lesson 7 summary

  - `n d` searches; `l` and `j` then move between matches.
  - `m` jumps to a labelled word; `M` goes to a line by number.


# Lesson 8: structure

## Lesson 8.1: nodes

`d` selects *nodes*: the bracketed structure of the text (in Lisp, its
s-expressions). In NODE mode, `k` goes into a node, to its first child, `i`
back out to its parent, and `j` and `l` go between siblings.

  1. On the line below, press `d`: the whole expression is selected.
  2. Press `k` (the +), `l` (the 1), `l` (the inner expression), `k` (the
     *), and `i` to come back out.
  3. Delete the 1: press `d`, `k`, `l`, and tap `r`.

    (+ 1 (* 2 3))
  ✓ (+ (* 2 3))


## Lesson 8.2: surrounding

`,` works with what surrounds the selection. `, s` then a bracket key wraps
the selection: `m` for ( ), `,` for [ ], `.` for { }, `k` for " ". `, r m`
removes the parentheses around the selection, and `, d m` selects inside
them.

  1. Select "me" below (`s` `p`) and press `,` `s` `m`.

    wrap me
  ✓ wrap (me)

  2. Select "this" below (`s` `y`, `l`) and press `,` `r` `m`.

    free (this) word
  ✓ free this word


## Lesson 8.3: transforming

`F` transforms the selection: `F q` UPPER CASE, `F a` lower case, `F s`
snake_case, `F d` camelCase, `F k` comments it out or back in.

  1. Select "loud" below (`s` `p`) and press `F` `q`.

    make this loud
  ✓ make this LOUD

`I` joins the next line onto this one, `K` breaks the line before the
selection, `L` indents the selected lines and `J` dedents them.

  2. On the first line below, press `I`.

    a line broken
    in two
  ✓ a line broken in two


## Lesson 8 summary

  - `d` selects nodes: `k` in, `i` out, `j` `l` between siblings.
  - `, s m` wraps in parentheses, `, r m` unwraps, `, d m` selects inside.
  - `F q` `F a`... change case; `I` joins, `K` breaks, `L` `J` indent.


# Lesson 9: files and buffers

Every open file is a *buffer*; when there are several, their names are
along the top of the screen.

  `enter`        saves the buffer (`shift+enter` saves it somewhere else)
  `space k d`    opens a file from the working directory, by fuzzy search
  `space ;`      browses the file system
  `space k f`    switches to a buffer by name (so does tapping `e`)
  `e l` `e j`    go to the next and previous buffer; `e n` closes one

This tutor is not a file yet: press `enter` and quad asks where to save it.
Press `esc` to say no, or give it a name.

Pickers, like `space k d`'s, filter as you type; `up` and `down` (or `tab`)
choose, `enter` takes the choice, `esc` cancels.


## Lesson 9 summary

  - `enter` saves; `space k d` opens a file; `space ;` browses.
  - `space k f` or `e` switches buffers; `e l` `e j` next and previous.


# Lesson 10: finding out more

You don't need to remember everything here:

  - After `space`, or holding a layer key like `r` a moment, the keys you
    can press next appear.
  - `space /` lists every key binding.
  - `space space` runs any command by name: try it, and type "tutor".

quad is written in Chez Scheme, and all of it can be changed while it
runs. `space e` evaluates Scheme: press it, type the line below, and press
`enter`.

    (message "Hello from ~a" (scheme-version))

Your configuration is a Scheme file, `~/.config/quad/init.ss`, loaded at
start. It can define commands, bind keys, change colours and add modes:
quad's guide, `docs/guide.md`, shows how, and `docs/examples/init.ss`
has more.

`space a` asks an AI agent (Codex) to change the editor for you: `space a
a`, then describe what you want, like "bind ctrl+d to duplicate the line".
It edits your init file and applies the change while you watch. It needs
OpenAI's `codex` command, installed and logged in.


## Lesson 10 summary

  - Hold a layer key to see its keys; `space /` lists them all.
  - `space space` runs a command by name; `space e` evaluates Scheme.
  - `~/.config/quad/init.ss` is yours to change; `space a` can help.

That is the tutor. Quit with `space j v`, or keep practising here.
