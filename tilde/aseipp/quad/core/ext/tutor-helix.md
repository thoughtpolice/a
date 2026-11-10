<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# The quad tutor, with Helix's keys

Welcome. quad is using Helix's keys, and this tutor teaches them as quad
has them. It is a buffer like any other: a fresh copy, for you to work
through by editing it. Nothing you do here touches a file unless you save
it, and `space k h` (or `quad --tutor`) brings back a clean copy.

Each lesson explains a few keys, then gives you lines to practise on. They
are indented, with what they should become underneath, marked ✓:

    Edit lines like this one.
  ✓ Until they look like this one.

Keys are written like `w`. Keys apart, like `x d`, are pressed one after
the other. If you know Helix already, skim: most of it is what you expect,
and lesson 10 is about quad itself.


# Lesson 1: moving

In *normal mode*, where you are now, keys are commands, not text. The
cursor moves with `h` `j` `k` `l`:

            k
          h   l        h left, j down, k up, l right
            j

The arrow keys and the mouse work too; a count first goes further: `5j`
is five lines down.

  1. Press `j` a few times to move down, and `k` to move back up.
  2. Press `l` and `h` to move along a line.
  3. Keep pressing `j` until you reach Lesson 1.1.

`ctrl+d` and `ctrl+u` scroll half a page down and up.


## Lesson 1.1: going places

`g` goes places: `g g` to the first line, `g e` the last, `g h` the start
of this line, `g l` its end, and `g s` its first non-blank.

`:q` then `enter` quits; quad asks first if a file has unsaved changes,
and `:q!` quits anyway. Don't quit now; but when you do, `quad --tutor`
starts the tutor again, and `space k h` opens it from inside the editor.

The bottom line is the *status line*: it says `NOR` in normal mode.


## Lesson 1 summary

  - `h` `j` `k` `l` move, a count first goes further.
  - `gg` `ge` the first and last lines; `gh` `gl` `gs` on the line.
  - `:q` quits, `:q!` without saving; `space k h` opens the tutor.


# Lesson 2: selecting and deleting

Helix selects first, then acts: you say *what* (a selection), then *what to
do* with it. `w` selects from the cursor to the next word, the space after
it included; pressed again, it selects the next one. `b` selects back to a
word's start and `e` to its end. `d` deletes the selection.

  1. On the line below, press `w` until the second "cat " is selected,
     then `d`.

    The cat cat sat on the mat.
  ✓ The cat sat on the mat.

`x` selects the line (pressed again, the next one too), and `%` the whole
buffer. `;` drops the selection down to the cursor again.

  2. Delete the line in the middle: move to it and press `x` `d`.

    Keep this line.
    Delete this line.
    Keep this line too.
  ✓ Keep this line.
  ✓ Keep this line too.


## Lesson 2.1: undo

`u` undoes, and `U` redoes. Undo the last deletion with `u`, and bring it
back with `U`.


## Lesson 2 summary

  - `w` `b` `e` select words; `x` lines; `%` everything; `;` collapses.
  - `d` deletes the selection; `u` undoes, `U` redoes.


# Lesson 3: inserting

`i` starts *insert mode* before the selection; `a` after it. Type, then
press `esc` to go back to normal mode. The status line says `INS` while you
insert.

  1. On the line below, press `w` three times to select "editor", press
     `i`, type "an " (with the space), and press `esc`.

    quad is editor.
  ✓ quad is an editor.

`A` appends at the end of the line, and `I` inserts at its start.

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

  - `i` inserts before the selection, `a` after; `esc` ends inserting.
  - `A` at the line's end, `I` at its start; `o` `O` open a line.


# Lesson 4: changing

`c` changes the selection: it deletes it and starts inserting in its
place.

  1. On the line below, press `w` until "green" is selected, then `c`,
     type "blue", and press `esc`.

    The sky is green.
  ✓ The sky is blue.

`~` switches the selection's case; `` ` `` makes it lower case and
`` alt+` `` upper case. `>` and `<` indent and dedent its lines, and `J`
joins them.

  2. Select "loud" below (`w` `w` `w`) and press `` alt+` ``.

    make this loud
  ✓ make this LOUD


## Lesson 4 summary

  - `c` changes the selection.
  - `~` `` ` `` `` alt+` `` change case; `>` `<` indent; `J` joins.


# Lesson 5: yanking and pasting

`y` yanks (copies) the selection. `p` pastes after the selection, `P`
before it, and `R` replaces the selection with what was yanked. Deleting
yanks too, so `x d` then `p` moves a line.

  1. On the line below, press `w` (selecting "one "), `y`, then `w` again
     (selecting "two "), and `P`.

    one two three
  ✓ one one two three

  2. Put these lines in order: on "2. second", press `x` `d` (the cursor
     goes to "1. first"), then `x` `p` to paste it after that line.

    2. second
    1. first
    3. third
  ✓ 1. first
  ✓ 2. second
  ✓ 3. third


## Lesson 5.1: registers

Yanks and deletes go to the default register, which is also quad's
clipboard (and your system's, in terminals that allow it). `"` and a
letter before `y`, `d`, `c`, `p`, `P` or `R` use a register of that name
instead; `"_` throws away what goes into it. `:reg` shows them all.

  1. On "keep me" below, press `x` and `" k y`. Then `j` `x` `d` deletes
     "drop me"; go back up with `k`, then `x` and `" k p`: the line you
     kept, not the one you deleted.

    keep me
    drop me
  ✓ keep me
  ✓ keep me


## Lesson 5 summary

  - `y` yanks; `p` `P` paste after and before; `R` replaces.
  - `"a` before them uses register a; `:reg` lists them.


# Lesson 6: many selections

Everything acts on every selection at once.

`s` selects, within the selections, what a regular expression matches:
type it and press `enter`. `,` keeps only the primary selection, and
`esc` too, when there is nothing else to leave.

  1. On the line below, press `x` (the line), then `s`, type "cat", and
     press `enter`: every "cat" is selected. Then `c`, type "cow", press
     `esc`, and `,` to keep one selection.

    cat dog cat bird cat
  ✓ cow dog cow bird cow

`C` adds a cursor on the line below, at the same column (`alt+C` above).

  2. On the "a" below, press `C` `C` for a cursor on each line, then `i`,
     type "let ", press `esc`, and `,`.

    a = 1
    b = 2
    c = 3
  ✓ let a = 1
  ✓ let b = 2
  ✓ let c = 3

`alt+s` splits the selections into their lines, a selection each, and
`alt+;` flips which end of each one the cursor is at.


## Lesson 6.1: select mode

`v` starts *select mode*: then motions extend the selections instead of
replacing them. `v` again (or `esc`) leaves it.

  1. On "one" below, press `v`, then `w` `w` (to the space before
     "three"), and `d`.

    one two three four
  ✓ three four


## Lesson 6 summary

  - `s` selects matches within the selections; `alt+s` splits lines.
  - `C` adds a cursor below; `,` keeps one selection.
  - `v` extends with the motions that follow.


# Lesson 7: finding things

`/` searches forward: type what you are looking for (a regular
expression) and press `enter`; `?` searches backward. `n` selects the
next match, `N` the one before. `*` searches for what is selected.

  1. Press `/`, type "needle", and press `enter`. Then `n` for the next
     one, and `N` to come back.

    hay hay hay needle hay hay hay hay needle hay


## Lesson 7.1: matching

`m` works with brackets and what surrounds the selection. `m m` goes to
the bracket that matches the one under the cursor. `m i (` selects inside
the parentheses around the selection, and `m a (` with them; the same with
`[` `{` `<` and quotes.

  1. Put the cursor anywhere in "wrong, args" below, press `m` `i` `(`,
     then `c`, type "right", and press `esc`.

    call(wrong, args)
  ✓ call(right)

`m s (` surrounds the selection with parentheses, `m d (` deletes the ones
around it, and `m r ( [` replaces them with brackets.

  2. Select "me" below (`w` `w`) and press `m` `s` `(`.

    wrap me
  ✓ wrap (me)

  3. Put the cursor on "this" below and press `m` `d` `(`.

    free (this) word
  ✓ free this word


## Lesson 7 summary

  - `/` `?` search; `n` `N` next and previous; `*` the selection.
  - `mm` the matching bracket; `mi(` `ma(` select; `ms(` `md(` `mr([`.


# Lesson 8: macros

A *macro* is keys recorded to play back. `Q` starts recording (the status
line says `recording @@`), and `Q` again stops; `q` plays it, and a count
plays it that many times. `"` and a letter before `Q` or `q` keeps it in
that register instead.

  1. On "apple" below, press `Q` to record; then `I`, type "- ", press
     `esc`, `j` to go down, and `Q` to stop. Then `2 q` does the other two
     lines.

    apple
    banana
    cherry
  ✓ - apple
  ✓ - banana
  ✓ - cherry


## Lesson 8 summary

  - `Q` ... `Q` records a macro; `q` plays it, `2q` twice.


# Lesson 9: files and buffers

  `:w`           saves (`:w FILE` saves to that file)
  `:e FILE`      opens a file
  `space f`      opens a file from the working directory, by fuzzy search
  `space b`      switches to a buffer by name
  `g n` `g p`    go to the next and previous buffer; `:bd` closes one
  `:sp` `:vs`    split the window below and to the right

This tutor is not a file yet: `:w` asks where to save it. Press `esc` to
say no, or give it a name.

Pickers filter as you type; `up` and `down` (or `tab`) choose, `enter`
takes the choice, `esc` cancels.


## Lesson 9 summary

  - `:w` saves, `:e` opens; `space f` and `space b` pick files and buffers.
  - `gn` `gp` next and previous buffer; `:sp` `:vs` split.


# Lesson 10: quad

`space` opens quad's menu, the same with every key scheme. After it, the
keys you can press next appear:

  `space ;`        browses the file system
  `space /`        lists every key binding
  `space space`    runs any command by name (try it: type "tutor")
  `space j s`      picks the keys: Helix's, Vim's, or quad's own (Ki's)
  `ctrl+w`         works with panes: splitting, moving between them

quad is written in Chez Scheme, and all of it can be changed while it
runs. `space e` evaluates Scheme: press it, type the line below, and press
`enter`.

    (message "Hello from ~a" (scheme-version))

Your configuration is a Scheme file, `~/.config/quad/init.ss`, loaded at
start. `(set-var! 'key-scheme 'helix)` there keeps Helix's keys; it can
define commands, bind keys, change colours and add modes too: quad's
guide, `docs/guide.md`, shows how, and `docs/examples/init.ss` has more.


## Lesson 10 summary

  - `space` is quad's menu; `space /` lists the keys; `space e` evaluates.
  - `~/.config/quad/init.ss` is yours to change.

That is the tutor. Quit with `:q`, or keep practising here.
