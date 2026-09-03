// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_TERMINAL_H
#define CONSOLE_TERMINAL_H

#include "console.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>


#ifdef __cplusplus
extern "C" {
#endif

typedef struct terminal terminal;

/* One foreground terminal may be open at a time. Renderer is auto, kitty, or ansi. */
terminal *terminal_open(const char *renderer);
/* elapsed_ms is the delta since the previous poll, not an absolute timestamp. */
size_t terminal_poll(terminal *, uint64_t elapsed_ms, console_key_event *, size_t capacity);
/* Draw a frame. budget_ms is the application's frame period: when writing a
 * frame takes longer than twice that, later frames are dropped until the
 * terminal has caught up, so a slow terminal costs frames rather than time.
 * Zero disables the dropping. */
int terminal_present(terminal *, uint32_t width, uint32_t height, const uint8_t *rgba,
                     unsigned budget_ms);
bool terminal_should_quit(const terminal *);
/* True when the terminal reports key releases itself rather than the
 * decoder synthesizing them after a delay. */
bool terminal_key_releases(const terminal *);

typedef struct {
    int32_t x, y, dx, dy;
    uint32_t buttons;
    int32_t wheel;
    /* False until the terminal has reported the pointer at all. */
    bool seen;
} terminal_mouse;

/* The pointer over the last presented frame, in its pixels, with the motion
 * and wheel notches since the previous call. */
terminal_mouse terminal_read_mouse(terminal *);
/* Copies the text typed since the previous call, UTF-8, returning its length. */
size_t terminal_read_text(terminal *, char *text, size_t capacity);
/* Names the terminal's window or tab; the previous title comes back when the
 * terminal closes, where the terminal keeps a title stack. */
void terminal_set_title(terminal *, const char *title, size_t length);
/* Updates terminal dimensions; true until the next present repaints them. */
bool terminal_resized(terminal *);
void terminal_close(terminal *);

/* The decoder and frame writers have no terminal side effects: tests can use
 * fragmented byte streams, a synthetic clock, and ordinary FILE streams. */
#define TERMINAL_SEQUENCE_CAPACITY 256
#define TERMINAL_EVENT_CAPACITY 256
#define TERMINAL_TEXT_CAPACITY 256
#define TERMINAL_LEGACY_RELEASE_MS 180
#define TERMINAL_ESCAPE_MS 35
#define TERMINAL_KEY_COUNT CONSOLE_KEY_COUNT

typedef struct {
    unsigned char sequence[TERMINAL_SEQUENCE_CAPACITY];
    size_t sequence_length;
    unsigned mode;
    uint64_t sequence_since;
    bool held[TERMINAL_KEY_COUNT];
    bool delivered[TERMINAL_KEY_COUNT];
    uint8_t physical_modifiers[3];
    uint64_t release_at[TERMINAL_KEY_COUNT];
    console_key_event events[TERMINAL_EVENT_CAPACITY];
    size_t event_start, event_count;
    bool quit, overflowed;
    bool keyboard_supported, kitty_keyboard;
    uint32_t keyboard_flags;
    bool graphics_seen, graphics_supported, device_seen;
    /* SGR mouse reports as the terminal sent them, cells or pixels, with the
     * motion and wheel notches accumulated since they were last read. */
    int32_t mouse_x, mouse_y, mouse_dx, mouse_dy, mouse_wheel;
    uint32_t mouse_buttons;
    bool mouse_seen;
    char text[TERMINAL_TEXT_CAPACITY];
    size_t text_length;
} terminal_input;

void terminal_input_feed(terminal_input *, const unsigned char *, size_t, uint64_t now_ms);
void terminal_input_tick(terminal_input *, uint64_t now_ms);
size_t terminal_input_read(terminal_input *, console_key_event *, size_t capacity);

typedef struct {
    unsigned column, row, columns, rows;
} terminal_viewport;

terminal_viewport terminal_fit(unsigned columns, unsigned rows,
                               unsigned pixel_width, unsigned pixel_height);
/* Maps the decoder's mouse state onto a width by height frame shown in the
 * viewport, whose cells are cell_width by cell_height pixels when the reports
 * are in pixels, and takes the accumulated motion and wheel notches. */
terminal_mouse terminal_input_read_mouse(terminal_input *, terminal_viewport, bool pixels,
                                         unsigned cell_width, unsigned cell_height,
                                         uint32_t width, uint32_t height);
size_t terminal_input_read_text(terminal_input *, char *text, size_t capacity);
int terminal_write_ansi(FILE *, terminal_viewport, uint32_t width, uint32_t height,
                        const uint8_t *rgba);
int terminal_write_kitty(FILE *, terminal_viewport, uint32_t image_id,
                         uint32_t width, uint32_t height, const uint8_t *rgba);


#ifdef __cplusplus
}
#endif

#endif
