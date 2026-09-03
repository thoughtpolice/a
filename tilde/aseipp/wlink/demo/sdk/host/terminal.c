// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define _POSIX_C_SOURCE 200809L
/* Darwin's headers hide their BSD extensions, SIGWINCH among them, once
 * _POSIX_C_SOURCE is set, unless this asks for them back. */
#define _DARWIN_C_SOURCE
#include "terminal.h"

#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum { INPUT_TEXT, INPUT_ESCAPE, INPUT_CSI, INPUT_SS3, INPUT_STRING, INPUT_STRING_ESCAPE };
enum { IMAGE_FIRST = 42424241, IMAGE_SECOND = 42424242, IMAGE_QUERY = 42424243 };
/* Every terminal answers the device attributes query that ends negotiation,
 * so the bound only delays one that never answers. It has to cover a round
 * trip over SSH or a stalled reader, or capabilities are silently dropped. */
enum { NEGOTIATION_MS = 1000, SEQUENCE_TIMEOUT_MS = 250 };

struct terminal {
    struct termios saved_termios;
    bool raw, alternate, keyboard_pushed, kitty, resized, pixel_mouse;
    terminal_viewport view;
    uint32_t frame_width, frame_height;
    unsigned handlers;
    struct sigaction saved_handlers[4];
    struct winsize size;
    terminal_input input;
    uint64_t now_ms;
    uint64_t present_resume_ms;
    uint32_t image_id;
};

static terminal *active_terminal;
static volatile sig_atomic_t quit_signal, resize_signal;
static const int handled_signals[] = {SIGINT, SIGTERM, SIGHUP, SIGWINCH};

static uint64_t add_time(uint64_t a, uint64_t b) {
    return UINT64_MAX - a < b ? UINT64_MAX : a + b;
}

static void queue_event(terminal_input *input, uint32_t key, bool pressed) {
    if (input->event_count == TERMINAL_EVENT_CAPACITY) {
        /* Reconcile every held key after an overrun, so dropping a release
         * cannot leave the application moving or firing indefinitely. */
        input->event_start = input->event_count = 0;
        input->overflowed = true;
        for (uint32_t k = 0; k < TERMINAL_KEY_COUNT; ++k) {
            if (input->held[k] || input->delivered[k]) {
                input->events[input->event_count++] = (console_key_event){.key = k, .pressed = 0};
            }
            input->held[k] = false;
            input->release_at[k] = 0;
        }
    }
    size_t index = (input->event_start + input->event_count++) % TERMINAL_EVENT_CAPACITY;
    input->events[index] = (console_key_event){.key = key, .pressed = pressed};
}

static void key_event(terminal_input *input, int key, bool pressed, bool legacy, uint64_t now) {
    if (key < 0 || key >= TERMINAL_KEY_COUNT) return;
    if (input->held[key] != pressed) queue_event(input, (uint32_t)key, pressed);
    input->held[key] = pressed;
    input->release_at[key] = pressed && legacy ? add_time(now, TERMINAL_LEGACY_RELEASE_MS) : 0;
}

static int ascii_key(uint32_t code) {
    if (code >= 'a' && code <= 'z') return CONSOLE_SDK_INPUT_KEY_A + (int)(code - 'a');
    if (code >= 'A' && code <= 'Z') return CONSOLE_SDK_INPUT_KEY_A + (int)(code - 'A');
    if (code >= '0' && code <= '9') return CONSOLE_SDK_INPUT_KEY_NUM0 + (int)(code - '0');
    switch (code) {
    case 9: return CONSOLE_SDK_INPUT_KEY_TAB;
    case 10: case 13: return CONSOLE_SDK_INPUT_KEY_ENTER;
    case 27: return CONSOLE_SDK_INPUT_KEY_ESCAPE;
    case ' ': return CONSOLE_SDK_INPUT_KEY_SPACE;
    case 8: case 127: return CONSOLE_SDK_INPUT_KEY_BACKSPACE;
    case '-': case '_': return CONSOLE_SDK_INPUT_KEY_MINUS;
    case '=': case '+': return CONSOLE_SDK_INPUT_KEY_EQUALS;
    case ',': case '<': return CONSOLE_SDK_INPUT_KEY_COMMA;
    case '.': case '>': return CONSOLE_SDK_INPUT_KEY_PERIOD;
    case '/': case '?': return CONSOLE_SDK_INPUT_KEY_SLASH;
    case ';': case ':': return CONSOLE_SDK_INPUT_KEY_SEMICOLON;
    case '\'': case '"': return CONSOLE_SDK_INPUT_KEY_APOSTROPHE;
    case '[': case '{': return CONSOLE_SDK_INPUT_KEY_LEFT_BRACKET;
    case ']': case '}': return CONSOLE_SDK_INPUT_KEY_RIGHT_BRACKET;
    case '\\': case '|': return CONSOLE_SDK_INPUT_KEY_BACKSLASH;
    case '`': case '~': return CONSOLE_SDK_INPUT_KEY_GRAVE;
    case 57362: return CONSOLE_SDK_INPUT_KEY_PAUSE;
    case 57358: return CONSOLE_SDK_INPUT_KEY_CAPS_LOCK;
    case 57399: case 57400: case 57401: case 57402: case 57403:
    case 57404: case 57405: case 57406: case 57407: case 57408:
        return CONSOLE_SDK_INPUT_KEY_KP0 + (int)(code - 57399);
    case 57409: return CONSOLE_SDK_INPUT_KEY_KP_PERIOD;
    case 57410: return CONSOLE_SDK_INPUT_KEY_KP_DIVIDE;
    case 57411: return CONSOLE_SDK_INPUT_KEY_KP_MULTIPLY;
    case 57412: return CONSOLE_SDK_INPUT_KEY_KP_MINUS;
    case 57413: return CONSOLE_SDK_INPUT_KEY_KP_PLUS;
    case 57414: return CONSOLE_SDK_INPUT_KEY_KP_ENTER;
    case 57441: case 57447: return CONSOLE_SDK_INPUT_KEY_SHIFT;
    case 57442: case 57448: return CONSOLE_SDK_INPUT_KEY_CONTROL;
    case 57443: case 57449: return CONSOLE_SDK_INPUT_KEY_ALT;
    default: return -1;
    }
}

static void modified_key(terminal_input *input, int key, unsigned modifiers,
                         unsigned event, bool legacy, uint64_t now) {
    if (event < 1 || event > 3 || key < 0) return;
    if (key == CONSOLE_SDK_INPUT_KEY_C && (modifiers & 4) && event != 3) input->quit = true;
    const int keys[] = {CONSOLE_SDK_INPUT_KEY_SHIFT, CONSOLE_SDK_INPUT_KEY_ALT, CONSOLE_SDK_INPUT_KEY_CONTROL};
    for (unsigned i = 0; i < 3; ++i) {
        if (key != keys[i]) {
            /* Legacy modifiers have no separate releases. A following plain
             * key or the same short timeout releases their inferred state. */
            key_event(input, keys[i], (modifiers & (1u << i)) != 0, legacy, now);
        }
    }
    key_event(input, key, event != 3, legacy, now);
}

/* Typed text: printable bytes as the terminal sent them, so a multibyte
 * character arrives whole once its bytes have. Overflow drops the text. */
static void append_text(terminal_input *input, const char *bytes, size_t length) {
    if (input->text_length + length > TERMINAL_TEXT_CAPACITY) return;
    memcpy(input->text + input->text_length, bytes, length);
    input->text_length += length;
}

static void append_codepoint(terminal_input *input, uint32_t code) {
    char utf8[4];
    size_t length;
    if (code < 0x80) {
        utf8[0] = (char)code;
        length = 1;
    } else if (code < 0x800) {
        utf8[0] = (char)(0xc0 | code >> 6);
        utf8[1] = (char)(0x80 | (code & 0x3f));
        length = 2;
    } else if (code < 0x10000) {
        if (code >= 0xd800 && code <= 0xdfff) return;
        utf8[0] = (char)(0xe0 | code >> 12);
        utf8[1] = (char)(0x80 | ((code >> 6) & 0x3f));
        utf8[2] = (char)(0x80 | (code & 0x3f));
        length = 3;
    } else if (code <= 0x10ffff) {
        utf8[0] = (char)(0xf0 | code >> 18);
        utf8[1] = (char)(0x80 | ((code >> 12) & 0x3f));
        utf8[2] = (char)(0x80 | ((code >> 6) & 0x3f));
        utf8[3] = (char)(0x80 | (code & 0x3f));
        length = 4;
    } else return;
    append_text(input, utf8, length);
}

static void text_key(terminal_input *input, unsigned char c, bool alt, uint64_t now) {
    unsigned modifiers = alt ? 2 : 0;
    int key;
    if (c == 3) {
        input->quit = true;
        return;
    }
    if (!alt && (c >= 0x20 && c != 127)) append_text(input, (const char *)&c, 1);
    if (c >= 1 && c <= 26 && c != 8 && c != 9 && c != 10 && c != 13) {
        modifiers |= 4;
        key = CONSOLE_SDK_INPUT_KEY_A + c - 1;
    } else if (c == 0) {
        modifiers |= 4;
        key = CONSOLE_SDK_INPUT_KEY_SPACE;
    } else {
        key = ascii_key(c);
        if (c >= 'A' && c <= 'Z') modifiers |= 1;
    }
    modified_key(input, key, modifiers, 1, true, now);
}

static bool decimal(const unsigned char **cursor, const unsigned char *end, uint32_t *value) {
    const unsigned char *p = *cursor;
    uint32_t n = 0;
    if (p == end || *p < '0' || *p > '9') return false;
    do {
        unsigned digit = *p++ - '0';
        if (n > (UINT32_MAX - digit) / 10) return false;
        n = n * 10 + digit;
    } while (p < end && *p >= '0' && *p <= '9');
    *cursor = p;
    *value = n;
    return true;
}

static int functional_key(unsigned char final, uint32_t code, bool ss3) {
    switch (final) {
    case 'A': return CONSOLE_SDK_INPUT_KEY_UP;
    case 'B': return CONSOLE_SDK_INPUT_KEY_DOWN;
    case 'C': return CONSOLE_SDK_INPUT_KEY_RIGHT;
    case 'D': return CONSOLE_SDK_INPUT_KEY_LEFT;
    case 'P': return CONSOLE_SDK_INPUT_KEY_F1;
    case 'Q': return CONSOLE_SDK_INPUT_KEY_F2;
    case 'R': return ss3 ? CONSOLE_SDK_INPUT_KEY_F3 : -1; /* CSI R is a cursor position reply. */
    case 'S': return CONSOLE_SDK_INPUT_KEY_F4;
    case 'Z': return CONSOLE_SDK_INPUT_KEY_TAB;
    case 'H': return CONSOLE_SDK_INPUT_KEY_HOME;
    case 'F': return CONSOLE_SDK_INPUT_KEY_END;
    case '~': {
        const unsigned numbers[] = {11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24};
        for (unsigned i = 0; i < sizeof(numbers) / sizeof(numbers[0]); ++i)
            if (code == numbers[i]) return CONSOLE_SDK_INPUT_KEY_F1 + (int)i;
        switch (code) {
        case 1: case 7: return CONSOLE_SDK_INPUT_KEY_HOME;
        case 2: return CONSOLE_SDK_INPUT_KEY_INSERT;
        case 3: return CONSOLE_SDK_INPUT_KEY_DELETE;
        case 4: case 8: return CONSOLE_SDK_INPUT_KEY_END;
        case 5: return CONSOLE_SDK_INPUT_KEY_PAGE_UP;
        case 6: return CONSOLE_SDK_INPUT_KEY_PAGE_DOWN;
        default: return -1;
        }
    }
    default: return -1;
    }
}

/* An SGR mouse report: CSI < button ; column ; row M for a press or motion,
 * m for a release. Buttons 0-2 are left, middle, right; 32 marks motion
 * and 64 the wheel, whose low bit tells up from down. */
static void mouse_report(terminal_input *input, const unsigned char *p, const unsigned char *end) {
    uint32_t button, x, y;
    if (!decimal(&p, end, &button) || p == end || *p++ != ';' ||
        !decimal(&p, end, &x) || p == end || *p++ != ';' ||
        !decimal(&p, end, &y) || p != end || x > INT32_MAX || y > INT32_MAX) return;
    if (input->mouse_seen) {
        input->mouse_dx += (int32_t)x - input->mouse_x;
        input->mouse_dy += (int32_t)y - input->mouse_y;
    }
    input->mouse_seen = true;
    input->mouse_x = (int32_t)x;
    input->mouse_y = (int32_t)y;
    if (button & 64) {
        if (*end == 'M') input->mouse_wheel += (button & 1) ? -1 : 1;
        return;
    }
    if (button & 32) return;
    const uint32_t bits[] = {1, 4, 2};
    if ((button & 3) == 3) return;
    if (*end == 'M') input->mouse_buttons |= bits[button & 3];
    else input->mouse_buttons &= ~bits[button & 3];
}

static void control_sequence(terminal_input *input, uint64_t now, bool ss3) {
    const unsigned char *p = input->sequence;
    const unsigned char *end = p + input->sequence_length - 1;
    unsigned char final = *end;
    uint32_t code = 1, modifiers = 1, event = 1;
    if (p < end && *p == '<' && (final == 'M' || final == 'm')) {
        mouse_report(input, p + 1, end);
        return;
    }
    if (p < end && *p == '?') {
        ++p;
        if (final == 'u' && decimal(&p, end, &code) && p == end) {
            input->keyboard_supported = true;
            input->keyboard_flags = code;
        } else if (final == 'c') {
            input->device_seen = true;
        }
        return;
    }
    if (final == 'c') {
        input->device_seen = true;
        return;
    }
    if (p < end && !decimal(&p, end, &code)) return;
    uint32_t shifted = 0, alternates = 0;
    while (p < end && *p == ':') { /* Alternate key codes: the shifted key first. */
        uint32_t alternate = 0;
        ++p;
        if (p < end && *p != ':' && *p != ';' && !decimal(&p, end, &alternate)) return;
        if (alternates++ == 0) shifted = alternate;
    }
    if (p < end && *p == ';') {
        ++p;
        if (p < end && *p != ';' && !decimal(&p, end, &modifiers)) return;
        if (modifiers == 0) return;
        if (p < end && *p == ':') {
            ++p;
            if (!decimal(&p, end, &event)) return;
        }
    }
    bool typed = false;
    if (p < end && *p == ';' && final == 'u') { /* The text the key produced. */
        do {
            uint32_t point;
            ++p;
            if (!decimal(&p, end, &point)) return;
            if (event != 3) append_codepoint(input, point);
            typed = true;
        } while (p < end && *p == ':');
    }
    if (p != end) return;
    int key = final == 'u' ? ascii_key(code) : functional_key(final, code, ss3);
    /* Without text reporting, a printable key without control or alt held
     * types its shifted alternate when shift is down, else itself. */
    if (final == 'u' && !typed && event != 3 && (modifiers - 1) < 2 && code >= 0x20 &&
        (code < 0xe000 || code > 0xf8ff)) {
        append_codepoint(input, (modifiers - 1) == 1 && shifted ? shifted : code);
    }
    if (final == 'u' && event >= 1 && event <= 3) {
        const uint32_t left[] = {57441, 57443, 57442};
        const uint32_t right[] = {57447, 57449, 57448};
        for (unsigned i = 0; i < 3; ++i) {
            unsigned bit = code == left[i] ? 1 : code == right[i] ? 2 : 0;
            if (bit) {
                if (event == 3) input->physical_modifiers[i] &= (uint8_t)~bit;
                else input->physical_modifiers[i] |= (uint8_t)bit;
                event = input->physical_modifiers[i] ? 1 : 3;
            }
        }
    }
    unsigned mods = modifiers - 1;
    if (final == 'Z') mods |= 1;
    modified_key(input, key, mods, event, !input->kitty_keyboard, now);
}

static void string_sequence(terminal_input *input) {
    static const char reply[] = "Gi=42424243;";
    size_t prefix = sizeof(reply) - 1;
    if (input->sequence_length >= prefix &&
        memcmp(input->sequence, reply, prefix) == 0) {
        input->graphics_seen = true;
        input->graphics_supported = input->sequence_length == prefix + 2 &&
                                    memcmp(input->sequence + prefix, "OK", 2) == 0;
    }
}

terminal_mouse terminal_input_read_mouse(terminal_input *input, terminal_viewport view, bool pixels,
                                         unsigned cell_width, unsigned cell_height,
                                         uint32_t width, uint32_t height) {
    terminal_mouse mouse = {0};
    if (!input->mouse_seen) return mouse;
    /* Cell reports are 1-based; a cell maps to the frame pixels it covers,
     * taken at its centre. */
    int64_t span_x = pixels ? (int64_t)view.columns * cell_width : view.columns;
    int64_t span_y = pixels ? (int64_t)view.rows * cell_height : view.rows;
    if (span_x <= 0) span_x = 1;
    if (span_y <= 0) span_y = 1;
    int64_t origin_x = pixels ? (int64_t)view.column * cell_width : view.column;
    int64_t origin_y = pixels ? (int64_t)view.row * cell_height : view.row;
    int64_t x = (int64_t)input->mouse_x - 1 - origin_x, y = (int64_t)input->mouse_y - 1 - origin_y;
    mouse.x = (int32_t)(((2 * x + 1) * width) / (2 * span_x));
    mouse.y = (int32_t)(((2 * y + 1) * height) / (2 * span_y));
    mouse.dx = (int32_t)(((int64_t)input->mouse_dx * width) / span_x);
    mouse.dy = (int32_t)(((int64_t)input->mouse_dy * height) / span_y);
    mouse.buttons = input->mouse_buttons;
    mouse.wheel = input->mouse_wheel;
    mouse.seen = true;
    input->mouse_dx = input->mouse_dy = input->mouse_wheel = 0;
    return mouse;
}

size_t terminal_input_read_text(terminal_input *input, char *text, size_t capacity) {
    size_t n = input->text_length < capacity ? input->text_length : capacity;
    memcpy(text, input->text, n);
    input->text_length = 0;
    return n;
}

void terminal_input_tick(terminal_input *input, uint64_t now) {
    if (input->mode == INPUT_ESCAPE && now >= input->sequence_since &&
        now - input->sequence_since >= TERMINAL_ESCAPE_MS) {
        input->mode = INPUT_TEXT;
        key_event(input, CONSOLE_SDK_INPUT_KEY_ESCAPE, true, true, now);
    } else if (input->mode != INPUT_TEXT && now >= input->sequence_since &&
               now - input->sequence_since >= SEQUENCE_TIMEOUT_MS) {
        input->mode = INPUT_TEXT;
        input->sequence_length = 0;
    }
    for (int key = 0; key < TERMINAL_KEY_COUNT; ++key)
        if (input->release_at[key] && now >= input->release_at[key])
            key_event(input, key, false, false, now);
}

void terminal_input_feed(terminal_input *input, const unsigned char *bytes, size_t length, uint64_t now) {
    terminal_input_tick(input, now);
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = bytes[i];
        if (c == 3) {
            input->quit = true;
            continue;
        }
        switch (input->mode) {
        case INPUT_TEXT:
            if (c == 27) {
                input->mode = INPUT_ESCAPE;
                input->sequence_since = now;
                input->sequence_length = 0;
            } else text_key(input, c, false, now);
            break;
        case INPUT_ESCAPE:
            if (c == '[') input->mode = INPUT_CSI;
            else if (c == 'O') input->mode = INPUT_SS3;
            else if (c == '_' || c == ']' || c == 'P' || c == '^' || c == 'X')
                input->mode = INPUT_STRING;
            else if (c == 27) {
                key_event(input, CONSOLE_SDK_INPUT_KEY_ESCAPE, true, true, now);
                input->sequence_since = now;
            } else {
                input->mode = INPUT_TEXT;
                text_key(input, c, true, now);
            }
            break;
        case INPUT_CSI: case INPUT_SS3:
            if (input->sequence_length < TERMINAL_SEQUENCE_CAPACITY)
                input->sequence[input->sequence_length++] = c;
            if (c >= 0x40 && c <= 0x7e) {
                if (input->sequence_length < TERMINAL_SEQUENCE_CAPACITY)
                    control_sequence(input, now, input->mode == INPUT_SS3);
                input->mode = INPUT_TEXT;
                input->sequence_length = 0;
            } else if (c == 27) {
                input->mode = INPUT_ESCAPE;
                input->sequence_since = now;
                input->sequence_length = 0;
            }
            break;
        case INPUT_STRING:
            if (c == 27) input->mode = INPUT_STRING_ESCAPE;
            else if (c == 7) {
                input->mode = INPUT_TEXT;
                input->sequence_length = 0;
            } else if (input->sequence_length < TERMINAL_SEQUENCE_CAPACITY)
                input->sequence[input->sequence_length++] = c;
            break;
        case INPUT_STRING_ESCAPE:
            if (c == '\\') {
                string_sequence(input);
                input->mode = INPUT_TEXT;
                input->sequence_length = 0;
            } else {
                input->mode = INPUT_STRING;
                if (input->sequence_length < TERMINAL_SEQUENCE_CAPACITY)
                    input->sequence[input->sequence_length++] = c;
            }
            break;
        }
    }
}

size_t terminal_input_read(terminal_input *input, console_key_event *events, size_t capacity) {
    size_t n = input->event_count < capacity ? input->event_count : capacity;
    for (size_t i = 0; i < n; ++i) {
        events[i] = input->events[(input->event_start + i) % TERMINAL_EVENT_CAPACITY];
        input->delivered[events[i].key] = events[i].pressed != 0;
    }
    input->event_start = (input->event_start + n) % TERMINAL_EVENT_CAPACITY;
    input->event_count -= n;
    return n;
}

terminal_viewport terminal_fit(unsigned columns, unsigned rows, unsigned pixel_width, unsigned pixel_height) {
    terminal_viewport view = {1, 1, 1, 1};
    if (!columns || rows < 2) return view;
    unsigned cell_w = pixel_width && pixel_height ? pixel_width / columns : 8;
    unsigned cell_h = pixel_width && pixel_height ? pixel_height / rows : 16;
    if (!cell_w) cell_w = 8;
    if (!cell_h) cell_h = 16;
    unsigned max_columns = columns > 512 ? 512 : columns;
    unsigned max_rows = rows - 1 > 256 ? 256 : rows - 1;
    uint64_t fitted_columns = (uint64_t)max_rows * cell_h * 4 / ((uint64_t)cell_w * 3);
    if (fitted_columns <= max_columns) {
        view.columns = fitted_columns ? (unsigned)fitted_columns : 1;
        view.rows = max_rows;
    } else {
        view.columns = max_columns;
        uint64_t fitted_rows = (uint64_t)max_columns * cell_w * 3 / ((uint64_t)cell_h * 4);
        view.rows = fitted_rows ? (unsigned)fitted_rows : 1;
    }
    view.column = (columns - view.columns) / 2 + 1;
    view.row = (rows - 1 - view.rows) / 2 + 1;
    return view;
}

static bool valid_frame(terminal_viewport view, uint32_t width, uint32_t height, const uint8_t *rgba) {
    return rgba && width && height && width <= 4096 && height <= 4096 &&
           view.columns && view.columns <= 512 && view.rows && view.rows <= 256;
}

int terminal_write_ansi(FILE *output, terminal_viewport view, uint32_t width,
                        uint32_t height, const uint8_t *rgba) {
    if (!output || !valid_frame(view, width, height, rgba)) return -1;
    for (unsigned row = 0; row < view.rows; ++row) {
        fprintf(output, "\033[%u;%uH", view.row + row, view.column);
        uint32_t previous_top = UINT32_MAX, previous_bottom = UINT32_MAX;
        for (unsigned column = 0; column < view.columns; ++column) {
            size_t x = (uint64_t)column * width / view.columns;
            size_t y0 = (uint64_t)(row * 2) * height / (view.rows * 2);
            size_t y1 = (uint64_t)(row * 2 + 1) * height / (view.rows * 2);
            const uint8_t *top = rgba + (y0 * width + x) * 4;
            const uint8_t *bottom = rgba + (y1 * width + x) * 4;
            uint32_t top_rgb = (uint32_t)top[0] << 16 | (uint32_t)top[1] << 8 | top[2];
            uint32_t bottom_rgb = (uint32_t)bottom[0] << 16 | (uint32_t)bottom[1] << 8 | bottom[2];
            if (top_rgb != previous_top)
                fprintf(output, "\033[38;2;%u;%u;%um", top[0], top[1], top[2]);
            if (bottom_rgb != previous_bottom)
                fprintf(output, "\033[48;2;%u;%u;%um", bottom[0], bottom[1], bottom[2]);
            fputs("\342\226\200", output); /* U+2580, upper half block. */
            previous_top = top_rgb;
            previous_bottom = bottom_rgb;
        }
    }
    fputs("\033[0m", output);
    return ferror(output) ? -1 : 0;
}

int terminal_write_kitty(FILE *output, terminal_viewport view, uint32_t image_id,
                         uint32_t width, uint32_t height, const uint8_t *rgba) {
    if (!output || !image_id || !valid_frame(view, width, height, rgba)) return -1;
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t pixels = (size_t)width * height;
    fprintf(output, "\033[%u;%uH", view.row, view.column);
    for (size_t offset = 0; offset < pixels;) {
        char encoded[4096];
        size_t count = pixels - offset;
        if (count > sizeof(encoded) / 4) count = sizeof(encoded) / 4;
        for (size_t i = 0; i < count; ++i) {
            const uint8_t *pixel = rgba + (offset + i) * 4;
            encoded[i * 4] = alphabet[pixel[0] >> 2];
            encoded[i * 4 + 1] = alphabet[((pixel[0] & 3) << 4) | (pixel[1] >> 4)];
            encoded[i * 4 + 2] = alphabet[((pixel[1] & 15) << 2) | (pixel[2] >> 6)];
            encoded[i * 4 + 3] = alphabet[pixel[2] & 63];
        }
        unsigned more = offset + count < pixels;
        if (!offset)
            fprintf(output, "\033_Ga=T,f=24,t=d,s=%u,v=%u,i=%u,p=1,q=2,C=1,c=%u,r=%u,m=%u;",
                    width, height, image_id, view.columns, view.rows, more);
        else fprintf(output, "\033_Gm=%u;", more);
        if (fwrite(encoded, 4, count, output) != count) return -1;
        fputs("\033\\", output);
        offset += count;
    }
    return ferror(output) ? -1 : 0;
}

static void signal_handler(int signal_number) {
    if (signal_number == SIGWINCH) resize_signal = 1;
    else quit_signal = 1;
}

static uint64_t monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static void read_available(terminal *term) {
    unsigned char bytes[1024];
    /* Bound each poll even if input arrives continuously. */
    for (unsigned attempt = 0; attempt < 16; ++attempt) {
        struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
        if (poll(&input, 1, 0) <= 0) break;
        if (input.revents & (POLLERR | POLLHUP | POLLNVAL)) {
            term->input.quit = true;
            break;
        }
        ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n > 0) terminal_input_feed(&term->input, bytes, (size_t)n, term->now_ms);
        else {
            if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
                term->input.quit = true;
            break;
        }
    }
}

static void negotiate(terminal *term) {
    uint64_t start = monotonic_ms();
    term->input.device_seen = false;
    if (fflush(stdout) != 0) {
        term->input.quit = true;
        return;
    }
    while (!term->input.device_seen && !quit_signal) {
        uint64_t elapsed = monotonic_ms() - start;
        if (elapsed >= NEGOTIATION_MS) break;
        struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
        int ready = poll(&input, 1, (int)(NEGOTIATION_MS - elapsed));
        if (ready > 0) {
            read_available(term);
            if (input.revents & (POLLERR | POLLHUP | POLLNVAL)) {
                term->input.quit = true;
                break;
            }
        } else if (ready == 0 || (ready < 0 && errno != EINTR)) break;
    }
}

static void restore_at_exit(void) {
    terminal_close(active_terminal);
}

terminal *terminal_open(const char *renderer) {
    bool automatic = renderer && strcmp(renderer, "auto") == 0;
    bool kitty = renderer && strcmp(renderer, "kitty") == 0;
    bool ansi = renderer && strcmp(renderer, "ansi") == 0;
    if ((!automatic && !kitty && !ansi) || active_terminal ||
        !isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO)) {
        fprintf(stderr, "terminal: requires a foreground TTY and renderer auto, kitty, or ansi\n");
        return NULL;
    }
    terminal *term = calloc(1, sizeof(*term));
    if (!term) return NULL;
    if (tcgetattr(STDIN_FILENO, &term->saved_termios) != 0) {
        free(term);
        return NULL;
    }
    struct termios raw = term->saved_termios;
    raw.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
    raw.c_oflag &= ~OPOST;
    raw.c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    raw.c_cflag = (raw.c_cflag & ~(CSIZE | PARENB)) | CS8;
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    /* VMIN=0 makes reads nonblocking without changing O_NONBLOCK on an
     * open-file description that stdin and stdout might share. */
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0) {
        free(term);
        return NULL;
    }
    term->raw = true;
    active_terminal = term;
    quit_signal = resize_signal = 0;
    struct sigaction action = {0};
    action.sa_handler = signal_handler;
    sigemptyset(&action.sa_mask);
    for (unsigned i = 0; i < sizeof(handled_signals) / sizeof(handled_signals[0]); ++i) {
        action.sa_flags = handled_signals[i] == SIGWINCH ? SA_RESTART : 0;
        if (sigaction(handled_signals[i], &action, &term->saved_handlers[i]) != 0) {
            terminal_close(term);
            return NULL;
        }
        ++term->handlers;
    }
    static bool exit_registered;
    if (!exit_registered) {
        if (atexit(restore_at_exit) != 0) {
            terminal_close(term);
            return NULL;
        }
        exit_registered = true;
    }
    fputs("\033[22;2t\033[?1049h\033[?25l\033[2J", stdout);
    term->alternate = true;
    if (!ansi) fputs("\033_Gi=42424243,s=1,v=1,a=q,t=d,f=24;AAAA\033\\", stdout);
    fputs("\033[?u\033[c", stdout);
    negotiate(term);
    term->kitty = !ansi && term->input.graphics_supported;
    if (kitty && !term->kitty) {
        terminal_close(term);
        fprintf(stderr, "terminal: Kitty graphics support was not acknowledged\n");
        return NULL;
    }
    if (term->input.keyboard_supported) {
        fputs("\033[>31u\033[?u\033[c", stdout);
        term->keyboard_pushed = true;
        term->input.keyboard_flags = 0;
        negotiate(term);
        term->input.kitty_keyboard = (term->input.keyboard_flags & 11) == 11;
        if (!term->input.kitty_keyboard) {
            fputs("\033[<u", stdout);
            term->keyboard_pushed = false;
        }
    }
    /* Any-motion mouse reports in SGR form, in pixels where the graphics
     * protocol suggests a terminal that reports them. */
    fputs("\033[?1003h\033[?1006h", stdout);
    if (term->kitty) {
        fputs("\033[?1016h", stdout);
        term->pixel_mouse = true;
    }
    resize_signal = 1;
    (void)terminal_resized(term);
    term->image_id = IMAGE_FIRST;
    fflush(stdout);
    return term;
}

bool terminal_should_quit(const terminal *term) {
    return !term || quit_signal || term->input.quit;
}

bool terminal_key_releases(const terminal *term) {
    return term && term->input.kitty_keyboard;
}

terminal_mouse terminal_read_mouse(terminal *term) {
    terminal_mouse none = {0};
    if (!term) return none;
    unsigned cell_width = term->size.ws_col ? term->size.ws_xpixel / term->size.ws_col : 0;
    unsigned cell_height = term->size.ws_row ? term->size.ws_ypixel / term->size.ws_row : 0;
    if (!cell_width) cell_width = 8;
    if (!cell_height) cell_height = 16;
    return terminal_input_read_mouse(&term->input, term->view, term->pixel_mouse, cell_width,
                                     cell_height, term->frame_width, term->frame_height);
}

size_t terminal_read_text(terminal *term, char *text, size_t capacity) {
    return term ? terminal_input_read_text(&term->input, text, capacity) : 0;
}

void terminal_set_title(terminal *term, const char *title, size_t length) {
    if (!term || !term->alternate) return;
    fputs("\033]2;", stdout);
    /* Control bytes would end or corrupt the sequence. */
    for (size_t i = 0; i < length && i < 256; ++i)
        if ((unsigned char)title[i] >= 0x20 && title[i] != 0x7f) fputc(title[i], stdout);
    fputs("\033\\", stdout);
    fflush(stdout);
}

bool terminal_resized(terminal *term) {
    if (!term) return false;
    struct winsize size = {0};
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) != 0 || !size.ws_col || !size.ws_row) {
        size.ws_col = 80;
        size.ws_row = 24;
    }
    bool changed = resize_signal || memcmp(&size, &term->size, sizeof(size)) != 0;
    resize_signal = 0;
    if (changed) {
        term->size = size;
        term->resized = true;
    }
    return term->resized;
}

size_t terminal_poll(terminal *term, uint64_t elapsed_ms, console_key_event *events, size_t capacity) {
    if (!term) return 0;
    term->now_ms = add_time(term->now_ms, elapsed_ms);
    read_available(term);
    terminal_input_tick(&term->input, term->now_ms);
    (void)terminal_resized(term);
    return terminal_input_read(&term->input, events, capacity);
}

int terminal_present(terminal *term, uint32_t width, uint32_t height, const uint8_t *rgba,
                     unsigned budget_ms) {
    if (!term) return -1;
    uint64_t started = monotonic_ms();
    /* A terminal that cannot absorb frames at the application's rate gets
     * fewer of them: while it is still behind on earlier frames, this one
     * is dropped rather than stalling the application. */
    if (budget_ms && started < term->present_resume_ms) return 0;
    if (term->resized) {
        fputs("\033[0m\033[2J", stdout);
        term->resized = false;
    }
    terminal_viewport view = terminal_fit(term->size.ws_col, term->size.ws_row,
                                          term->size.ws_xpixel, term->size.ws_ypixel);
    term->view = view;
    term->frame_width = width;
    term->frame_height = height;
    int result;
    if (term->kitty) {
        uint32_t previous = term->image_id == IMAGE_FIRST ? IMAGE_SECOND : IMAGE_FIRST;
        result = terminal_write_kitty(stdout, view, term->image_id, width, height, rgba);
        fprintf(stdout, "\033_Ga=d,d=I,i=%u,q=2\033\\", previous);
        term->image_id = previous;
    } else result = terminal_write_ansi(stdout, view, width, height, rgba);
    if (fflush(stdout) != 0) result = -1;
    if (result != 0) term->input.quit = true;
    uint64_t finished = monotonic_ms();
    uint64_t elapsed = finished - started;
    if (budget_ms && elapsed > 2 * (uint64_t)budget_ms)
        term->present_resume_ms = finished + (elapsed - budget_ms);
    return result;
}

void terminal_close(terminal *term) {
    if (!term) return;
    if (term->alternate) {
        /* A signal can interrupt a frame in the middle of an APC payload. */
        clearerr(stdout);
        fputs("\033\\", stdout);
        if (term->kitty)
            fprintf(stdout, "\033_Ga=d,d=I,i=%u,q=2\033\\\033_Ga=d,d=I,i=%u,q=2\033\\",
                    IMAGE_FIRST, IMAGE_SECOND);
        if (term->keyboard_pushed) fputs("\033[<u", stdout);
        fputs("\033[?1016l\033[?1006l\033[?1003l\033[0m\033[?25h\033[?1049l\033[23;2t", stdout);
        fflush(stdout);
    }
    if (term->raw) {
        tcsetattr(STDIN_FILENO, TCSANOW, &term->saved_termios);
    }
    for (unsigned i = 0; i < term->handlers; ++i)
        sigaction(handled_signals[i], &term->saved_handlers[i], NULL);
    if (active_terminal == term) active_terminal = NULL;
    free(term);
}
