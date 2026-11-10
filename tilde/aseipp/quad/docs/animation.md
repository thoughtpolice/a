<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Animation

quad's widgets (core/widget.sls) draw cells. Animation adds two things to
them, in the manner of Anime.js: values that move over time, and effects
drawn over what widgets draw, finer than cells where the client can.

## Timing

Everything that moves is timed the same way, by a *timing*:

| | |
| --- | --- |
| `duration` | milliseconds an iteration takes |
| `delay` | milliseconds before the first |
| `end-delay` | milliseconds after each, before the next |
| `loop` | iterations: a number, or `#t` for ever |
| `direction` | `normal`, `reverse`, or `alternate` (back and forth) |
| `easing` | how progress goes: Anime.js's names, below |

Easings: `linear`; `in-`, `out-`, `in-out-` and `out-in-` each of `quad`,
`cubic`, `quart`, `quint`, `sine`, `expo`, `circ`, `back`, `elastic` and
`bounce`; `(cubic-bezier x1 y1 x2 y2)`; `(steps n)`; `(spring mass
stiffness damping velocity)`.

Timing and easing are computed in one place, the kernel's `quad_fx` crate,
which Scheme calls for tweens and the window's renderer calls for effects,
so that every way of drawing agrees.

## Values that move: tweens and timelines (core/anim.sls)

An *animated value* is a cell a widget reads as it draws (widgets already
take thunks). `animate!` moves values to targets:

```scheme
(define x (animated 0))                     ; a number
(define c (animated-color #x202020))        ; a color, mixed in sRGB
(animate! x 30 'duration 400 'easing 'out-cubic)
(animate! (list a b c) 1 'delay (stagger 80))      ; one after another
(animate! x '(0 10 4 10) 'duration 900)            ; keyframes
(define tl (timeline 'easing 'out-quad))
(timeline-add! tl x 10 'duration 200)
(timeline-add! tl c #xffffff 'duration 300 'offset "-=100")
(animation-pause! tl) (animation-seek! tl 150) (animation-play! tl)
```

Options: the timing's, and `on-update`, `on-complete`. While anything
moves, the server's loop wakes for the next frame (`animation-fps`, 60) and
redraws; otherwise it waits, using nothing. Tweens change what cells show,
so they work in every client alike. `(set-var! 'animations #f)` (reduced
motion) makes every animation jump to its end, and effects stand still.

## Effects: finer than cells

An *effect* is a kind, its parameters and a timing, placed over a rectangle
of cells by the widget it wraps:

```scheme
(with-effect (text-lines logo) (effect 'sheen 'angle 25 'width 4 'intensity 0.6
                                       'duration 1300 'end-delay 3500 'loop #t
                                       'easing 'in-out-sine))
```

`sheen` is a band of light that crosses the text it covers, along an angle.
More kinds (`fade`, `pulse`, `shimmer`, `glow`) follow the same shape: a
function of the effect's progress (eased), a point in the rectangle (in cell
widths across and down, so that angles mean the same however cells are
shaped), and the color of the ink there. It shades text: backgrounds stay.

Each client draws an effect the best way it can:

1. **Windows (Vulkan, Metal)**: exactly, per pixel, in the glyph shader
   (kernel/render/gui.slang), timed by the window itself. The server sends
   the effects placed in a frame once (`("effects" ...)`, with each one's
   age), not a frame at a time, so that a window animates at its display's
   rate with nothing from the editor, even over the network. The window
   redraws only while an effect moves, and sleeps until the next iteration
   between them.
2. **Terminals that show images (kitty's graphics protocol)**: the editor
   draws the effect's rectangle on the CPU (`quad_fx`'s raster: the cells'
   backgrounds and their block elements and box drawing, with the effect)
   at `animation-fps`, frames quantized so that each is a picture made once
   and kept by the terminal: after the first iteration, only placements are
   sent. A rectangle with other characters in it (which the raster does not
   draw yet) is drawn as cells instead (3).
3. **Every other terminal**: the editor shades each cell's foreground at
   its center, per frame, as the effect would there.

The window and the CPU raster compute the same function, in Slang and Rust:
tests draw one effect at one progress both ways (on lavapipe) and compare.

## Steps

1. `kernel/fx`: easings, timing (progress at a time, the next time it
   changes), effects (sheen), the CPU raster; natives for Scheme.
2. `core/anim.sls`: animated values, `animate!`, staggers, keyframes,
   timelines, controls, the clock (a test can set it), effects and
   `with-effect`; the server's loop waking for frames.
3. Display: each client's tier, from its capabilities; `("effects" ...)`
   to windows, pictures to terminals that show images, shaded cells to the
   rest.
4. Windows: effects in the frame update, a buffer of them for the shaders,
   the glyph shader shading text, redrawing while effects move and waking
   for the next iteration, the rows they cover damaged.
5. The setup splash: a sheen across quad's banner.
