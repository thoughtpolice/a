// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
        exit(1); \
    } \
} while (0)

static void feed(terminal_input *input, const char *text, uint64_t now) {
    terminal_input_feed(input, (const unsigned char *)text, strlen(text), now);
}

static void expect_event(terminal_input *input, uint32_t key, bool pressed) {
    console_key_event event;
    CHECK(terminal_input_read(input, &event, 1) == 1);
    CHECK(event.key == key);
    CHECK(event.pressed == pressed);
    CHECK(event.padding[0] == 0 && event.padding[1] == 0 && event.padding[2] == 0);
}

static void expect_empty(terminal_input *input) {
    console_key_event event;
    CHECK(terminal_input_read(input, &event, 1) == 0);
}

static void legacy_input(void) {
    terminal_input input = {0};
    feed(&input, "\033", 0);
    expect_empty(&input);
    feed(&input, "[", 1);
    feed(&input, "A", 2);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_UP, true);
    feed(&input, "\033[A", 100);
    expect_empty(&input); /* A repeat extends the inferred hold. */
    terminal_input_tick(&input, 100 + TERMINAL_LEGACY_RELEASE_MS - 1);
    expect_empty(&input);
    terminal_input_tick(&input, 100 + TERMINAL_LEGACY_RELEASE_MS);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_UP, false);
    feed(&input, "\033", 500);
    terminal_input_tick(&input, 500 + TERMINAL_ESCAPE_MS - 1);
    expect_empty(&input);
    terminal_input_tick(&input, 500 + TERMINAL_ESCAPE_MS);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_ESCAPE, true);
    terminal_input_tick(&input, 1000);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_ESCAPE, false);
    feed(&input, "\033OP\033[24~", 1001);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_F1, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_F12, true);
    feed(&input, "\033[12;34R", 1002); /* Cursor position report, not F3. */
    expect_empty(&input);
    feed(&input, "W", 1003);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_SHIFT, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_W, true);
    feed(&input, "a", 1004);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_SHIFT, false);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, true);
}

static void kitty_input(void) {
    terminal_input input = {.kitty_keyboard = true};
    const char *press = "\033[119;1:1u";
    for (size_t i = 0; i < strlen(press); ++i)
        terminal_input_feed(&input, (const unsigned char *)press + i, 1, i);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_W, true);
    terminal_input_tick(&input, 10000);
    expect_empty(&input); /* Actual key releases do not time out. */
    feed(&input, "\033[119;1:2u", 10001);
    expect_empty(&input);
    feed(&input, "\033[119;1:3u", 10002);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_W, false);
    feed(&input, "\033[1;1:1A\033[1;1:3A", 10003);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_UP, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_UP, false);
    feed(&input, "\033[57442;5:1u", 10004);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_CONTROL, true);
    feed(&input, "\033[57442;1:3u", 10005);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_CONTROL, false);
    feed(&input, "\033[57441;2:1u\033[57447;2:1u\033[57441;2:3u", 10005);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_SHIFT, true);
    expect_empty(&input); /* Releasing left shift preserves held right shift. */
    feed(&input, "\033[57447;1:3u", 10005);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_SHIFT, false);
    feed(&input, "\033[97:65;1:1u\033[97;1:3u", 10006);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, false);
    feed(&input, "\033[99;5:1u", 10007);
    CHECK(input.quit);
    input.quit = false;
    feed(&input, "\033]unterminated\003", 10008);
    CHECK(input.quit);
}

static void protocol_replies(void) {
    terminal_input input = {0};
    const char *reply = "\033_Gi=42424243;OK\033\\\033[?11u\033[?62;4c";
    for (size_t i = 0; i < strlen(reply); ++i)
        terminal_input_feed(&input, (const unsigned char *)reply + i, 1, i);
    CHECK(input.graphics_seen && input.graphics_supported);
    CHECK(input.keyboard_supported && input.keyboard_flags == 11);
    CHECK(input.device_seen);
    expect_empty(&input);
    feed(&input, "\033_Gi=42424243;EINVAL\033\\", 100);
    CHECK(input.graphics_seen && !input.graphics_supported);
    /* The protocols are independent: a graphics error changes no keyboard flags. */
    CHECK(input.keyboard_supported && input.keyboard_flags == 11);
    feed(&input, "\033_Gi=7;OK\033\\\033]title\007\033[>0;1c", 101);
    expect_empty(&input);
}

static void expect_text(terminal_input *input, const char *expected) {
    char text[TERMINAL_TEXT_CAPACITY];
    size_t length = terminal_input_read_text(input, text, sizeof(text));
    CHECK(length == strlen(expected));
    CHECK(memcmp(text, expected, length) == 0);
}

static void mouse_and_text(void) {
    terminal_input input = {.kitty_keyboard = true};
    terminal_viewport view = terminal_fit(80, 24, 640, 384); /* 61x23 cells at column 10, row 1. */
    terminal_mouse mouse = terminal_input_read_mouse(&input, view, false, 8, 16, 320, 200);
    CHECK(!mouse.seen && mouse.x == 0 && mouse.y == 0 && mouse.buttons == 0); /* Nothing reported yet. */
    feed(&input, "\033[<0;41;12M", 0); /* Left press in the middle of the frame. */
    mouse = terminal_input_read_mouse(&input, view, false, 8, 16, 320, 200);
    CHECK(mouse.x == 160 && mouse.y == 91 && mouse.dx == 0 && mouse.dy == 0);
    CHECK(mouse.buttons == 1 && mouse.wheel == 0);
    feed(&input, "\033[<32;45;12M\033[<0;45;12m", 1); /* Drag four cells, release. */
    mouse = terminal_input_read_mouse(&input, view, false, 8, 16, 320, 200);
    CHECK(mouse.x == 180 && mouse.dx == 20 && mouse.dy == 0 && mouse.buttons == 0);
    feed(&input, "\033[<64;45;12M\033[<65;45;12M\033[<65;45;12M\033[<2;45;12M\033[<1;45;12M", 2);
    mouse = terminal_input_read_mouse(&input, view, false, 8, 16, 320, 200);
    CHECK(mouse.wheel == -1 && mouse.buttons == 6 && mouse.dx == 0);
    mouse = terminal_input_read_mouse(&input, view, false, 8, 16, 320, 200);
    CHECK(mouse.wheel == 0 && mouse.buttons == 6);
    feed(&input, "\033[<2;45;12m\033[<1;45;12m", 3);
    /* Pixel reports: the same middle of the frame in a 640x384 window. */
    feed(&input, "\033[<35;325;185M", 4);
    mouse = terminal_input_read_mouse(&input, view, true, 8, 16, 320, 200);
    CHECK(mouse.x == 160 && mouse.y == 91 && mouse.buttons == 0);
    expect_empty(&input); /* Mouse reports are not key events. */

    feed(&input, "\033[104;1:1;104u\033[104;1:3u", 5); /* h, with its text reported. */
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_H, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_H, false);
    feed(&input, "\033[104:72;2:1u\033[104:72;2:3u", 6); /* Shift-h without text: its shifted key. */
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_SHIFT, true);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_H, true);
    feed(&input, "\033[9731;1:1;9731u\033[57399;1:1u\033[104;5:1u", 7); /* A snowman, kp0, ctrl-h. */
    expect_text(&input, "hH\xe2\x98\x83");
    expect_text(&input, "");
    feed(&input, "\033[2~\033[3~\033[H\033[F\033[5~\033[6~\033[57358u\033[57414u\033[57410u", 8);
    const uint32_t keys[] = {CONSOLE_SDK_INPUT_KEY_INSERT, CONSOLE_SDK_INPUT_KEY_DELETE,
                             CONSOLE_SDK_INPUT_KEY_HOME, CONSOLE_SDK_INPUT_KEY_END,
                             CONSOLE_SDK_INPUT_KEY_PAGE_UP, CONSOLE_SDK_INPUT_KEY_PAGE_DOWN,
                             CONSOLE_SDK_INPUT_KEY_CAPS_LOCK, CONSOLE_SDK_INPUT_KEY_KP_ENTER,
                             CONSOLE_SDK_INPUT_KEY_KP_DIVIDE};
    console_key_event events[64];
    size_t count = terminal_input_read(&input, events, 64);
    size_t seen = 0;
    for (size_t i = 0; i < count; ++i)
        if (events[i].pressed && seen < 9 && events[i].key == keys[seen]) ++seen;
    CHECK(seen == 9);

    terminal_input legacy = {0};
    feed(&legacy, "Hi!\xe2\x98\x83\033[<0;1;1M\033[<0;1;1m", 0);
    expect_text(&legacy, "Hi!\xe2\x98\x83");
    mouse = terminal_input_read_mouse(&legacy, view, false, 8, 16, 320, 200);
    CHECK(mouse.x < 0 && mouse.y < 0 && mouse.buttons == 0 && mouse.seen); /* Outside the viewport. */
}

static void malformed_and_overflow(void) {
    terminal_input input = {.kitty_keyboard = true};
    feed(&input, "\033[9999999999999999999999999999u\033[97;0u\033[97;1:9u", 0);
    expect_empty(&input);
    feed(&input, "\033[", 1);
    unsigned char oversized[1024];
    memset(oversized, '9', sizeof(oversized));
    terminal_input_feed(&input, oversized, sizeof(oversized), 2);
    CHECK(input.sequence_length <= TERMINAL_SEQUENCE_CAPACITY);
    feed(&input, "ua", 3);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, true);
    terminal_input_tick(&input, 300);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, false);
    feed(&input, "\033[97;1:1u", 301);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_A, true);
    feed(&input, "\033[97;1:3u", 302); /* Release queued but not yet delivered. */
    for (unsigned i = 0; i < 400; ++i)
        feed(&input, "\033[98;1:1u\033[98;1:3u", 303 + i);
    CHECK(input.overflowed);
    CHECK(input.event_count <= TERMINAL_EVENT_CAPACITY);
    bool held[TERMINAL_KEY_COUNT] = {0};
    held[CONSOLE_SDK_INPUT_KEY_A] = true;
    console_key_event events[13];
    size_t count;
    while ((count = terminal_input_read(&input, events, 13)) != 0)
        for (size_t i = 0; i < count; ++i) held[events[i].key] = events[i].pressed;
    for (size_t i = 0; i < TERMINAL_KEY_COUNT; ++i) CHECK(!held[i]);
    feed(&input, "\033[123;", 1000);
    terminal_input_tick(&input, 2000);
    feed(&input, "z", 2001);
    expect_event(&input, CONSOLE_SDK_INPUT_KEY_Z, true);
}

static char *contents(FILE *file, size_t *length) {
    CHECK(fflush(file) == 0);
    long size = ftell(file);
    CHECK(size >= 0);
    *length = (size_t)size;
    char *result = malloc(*length + 1);
    CHECK(result != NULL);
    rewind(file);
    CHECK(fread(result, 1, *length, file) == *length);
    result[*length] = 0;
    return result;
}

static void render_ansi(void) {
    const uint8_t pixels[] = {255, 0, 0, 255, 0, 255, 0, 255};
    terminal_viewport view = {2, 3, 1, 1};
    FILE *output = tmpfile();
    CHECK(output != NULL);
    CHECK(terminal_write_ansi(output, view, 1, 2, pixels) == 0);
    size_t length;
    char *text = contents(output, &length);
    CHECK(strcmp(text, "\033[3;2H\033[38;2;255;0;0m\033[48;2;0;255;0m\342\226\200\033[0m") == 0);
    CHECK(terminal_write_ansi(output, view, 0, 2, pixels) == -1);
    CHECK(terminal_write_ansi(output, view, UINT32_MAX, 2, pixels) == -1);
    free(text);
    fclose(output);
}

static unsigned decode64(unsigned char c) {
    const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const char *p = strchr(alphabet, c);
    CHECK(p != NULL);
    return (unsigned)(p - alphabet);
}

static void render_kitty(void) {
    const size_t count = 1025; /* A full 4096-byte payload plus a second chunk. */
    uint8_t pixels[count * 4];
    for (size_t i = 0; i < count; ++i) {
        pixels[i * 4] = (uint8_t)i;
        pixels[i * 4 + 1] = (uint8_t)(i >> 4);
        pixels[i * 4 + 2] = (uint8_t)(255 - i);
        pixels[i * 4 + 3] = 73; /* Alpha must not enter the RGB payload. */
    }
    FILE *output = tmpfile();
    CHECK(output != NULL);
    terminal_viewport view = {1, 1, 40, 15};
    CHECK(terminal_write_kitty(output, view, 42, count, 1, pixels) == 0);
    size_t length;
    char *text = contents(output, &length);
    CHECK(strstr(text, "a=T,f=24,t=d,s=1025,v=1,i=42,p=1,q=2,C=1,c=40,r=15,m=1;") != NULL);
    size_t decoded = 0, chunks = 0;
    for (char *chunk = strstr(text, "\033_G"); chunk; chunk = strstr(chunk, "\033_G")) {
        char *payload = strchr(chunk, ';');
        CHECK(payload != NULL);
        ++payload;
        char *end = strstr(payload, "\033\\");
        CHECK(end != NULL);
        size_t size = (size_t)(end - payload);
        CHECK(size <= 4096 && size % 4 == 0);
        CHECK(size == (chunks ? 4 : 4096));
        if (chunks) CHECK(memcmp(chunk, "\033_Gm=0;", 7) == 0);
        for (size_t i = 0; i < size; i += 4) {
            unsigned a = decode64(payload[i]), b = decode64(payload[i + 1]);
            unsigned c = decode64(payload[i + 2]), d = decode64(payload[i + 3]);
            CHECK((uint8_t)((a << 2) | (b >> 4)) == pixels[decoded * 4]);
            CHECK((uint8_t)((b << 4) | (c >> 2)) == pixels[decoded * 4 + 1]);
            CHECK((uint8_t)((c << 6) | d) == pixels[decoded * 4 + 2]);
            ++decoded;
        }
        ++chunks;
        chunk = end + 2;
    }
    CHECK(chunks == 2 && decoded == count);
    free(text);
    fclose(output);
}

static void viewport(void) {
    terminal_viewport view = terminal_fit(80, 24, 640, 384);
    CHECK(view.columns == 61 && view.rows == 23);
    CHECK(view.column == 10 && view.row == 1);
    view = terminal_fit(80, 50, 640, 800);
    CHECK(view.columns == 80 && view.rows == 30);
    CHECK(view.row == 10);
    view = terminal_fit(0, 0, 0, 0);
    CHECK(view.columns == 1 && view.rows == 1);
    view = terminal_fit(UINT_MAX, UINT_MAX, UINT_MAX, UINT_MAX);
    CHECK(view.columns <= 512 && view.rows <= 256);
}

static uint64_t session_clock_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

/* A PTY test can exercise negotiation, resize, signal handling, and cleanup
 * without starting the game or relying on a particular terminal emulator. */
static int terminal_session(const char *renderer) {
    terminal *term = terminal_open(renderer);
    if (!term) return 2;
    const uint8_t pixels[] = {255, 0, 0, 255, 0, 255, 0, 255,
                              0, 0, 255, 255, 255, 255, 255, 255};
    size_t total_events = 0, mouse_events = 0, text_bytes = 0;
    /* Advance the terminal clock by real elapsed time, as the game host does,
     * rather than a fixed 10 ms per poll. The synthesized legacy key release
     * and the escape-sequence timeout are wall-clock deadlines; when the
     * scheduler spaces these 10 ms sleeps out, which macOS readily does under
     * load, a fixed step would stall the terminal's clock short of them. */
    uint64_t previous = session_clock_ms();
    for (unsigned i = 0; i < 500 && !terminal_should_quit(term); ++i) {
        console_key_event events[32];
        char text[TERMINAL_TEXT_CAPACITY];
        uint64_t now = session_clock_ms();
        total_events += terminal_poll(term, now - previous, events, 32);
        previous = now;
        terminal_mouse mouse = terminal_read_mouse(term);
        mouse_events += mouse.dx || mouse.dy || mouse.wheel || mouse.buttons;
        text_bytes += terminal_read_text(term, text, sizeof(text));
        if (i == 0 || terminal_resized(term)) {
            if (terminal_present(term, 2, 2, pixels, 0) != 0) break;
        }
        const struct timespec pause = {.tv_sec = 0, .tv_nsec = 10000000};
        nanosleep(&pause, NULL);
    }
    bool quit = terminal_should_quit(term);
    terminal_close(term);
    printf("terminal session: events=%zu mouse=%zu text=%zu quit=%u\n", total_events, mouse_events,
           text_bytes, quit ? 1u : 0u);
    return quit ? 0 : 3;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--session") == 0) return terminal_session(argv[2]);
    legacy_input();
    kitty_input();
    protocol_replies();
    mouse_and_text();
    malformed_and_overflow();
    render_ansi();
    render_kitty();
    viewport();
    puts("terminal: input, mouse, text, protocol negotiation, rendering, and overflow tests passed");
    return 0;
}
