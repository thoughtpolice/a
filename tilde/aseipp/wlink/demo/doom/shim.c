// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <string.h>

#include "console.h"
#include "runtime.h"
#include "stream.h"

#define DOOM_IMPLEMENTATION
#include "PureDOOM.h"

static bool initialized;
static bool wanted_keys[256];
static bool delivered_keys[256];

static void print_message(const char* message) {
  console_log(CONSOLE_SDK_LOG_LEVEL_INFO, message, (size_t)doom_strlen(message));
}

static _Noreturn void quit_game(int code) {
  console_process_exit(code);
}

static _Noreturn void fail(const char* message) {
  console_log(CONSOLE_SDK_LOG_LEVEL_ERROR, message, (size_t)doom_strlen(message));
  quit_game(1);
}

static void* allocate(int size) {
  if (size < 0) fail("PureDOOM requested a negative allocation size");
  return console_malloc((size_t)size);
}

static void get_time(int* seconds, int* microseconds) {
  uint64_t now = console_clock_now_ms();
  // I_GetTime treats a zero base second as uninitialized. The offset also
  // makes a synthetic clock beginning at zero behave like the real clock.
  *seconds = (int)(1 + now / 1000);
  *microseconds = (int)(now % 1000) * 1000;
}

static char* get_environment(const char* name) {
  if (doom_strcmp(name, "HOME") == 0 || doom_strcmp(name, "DOOMWADDIR") == 0)
    return ".";
  return NULL;
}

static int seek_file(void* file, int offset, doom_seek_t origin) {
  return console_stream_seek(file, offset, (int)origin);
}

static doom_key_t map_key(uint32_t key) {
  if (key >= CONSOLE_SDK_INPUT_KEY_A && key <= CONSOLE_SDK_INPUT_KEY_Z)
    return (doom_key_t)(DOOM_KEY_A + key - CONSOLE_SDK_INPUT_KEY_A);
  if (key >= CONSOLE_SDK_INPUT_KEY_NUM0 && key <= CONSOLE_SDK_INPUT_KEY_NUM9)
    return (doom_key_t)(DOOM_KEY_0 + key - CONSOLE_SDK_INPUT_KEY_NUM0);
  switch (key) {
    case CONSOLE_SDK_INPUT_KEY_TAB: return DOOM_KEY_TAB;
    case CONSOLE_SDK_INPUT_KEY_ENTER: return DOOM_KEY_ENTER;
    case CONSOLE_SDK_INPUT_KEY_ESCAPE: return DOOM_KEY_ESCAPE;
    case CONSOLE_SDK_INPUT_KEY_SPACE: return DOOM_KEY_SPACE;
    case CONSOLE_SDK_INPUT_KEY_BACKSPACE: return DOOM_KEY_BACKSPACE;
    case CONSOLE_SDK_INPUT_KEY_UP: return DOOM_KEY_UP_ARROW;
    case CONSOLE_SDK_INPUT_KEY_DOWN: return DOOM_KEY_DOWN_ARROW;
    case CONSOLE_SDK_INPUT_KEY_LEFT: return DOOM_KEY_LEFT_ARROW;
    case CONSOLE_SDK_INPUT_KEY_RIGHT: return DOOM_KEY_RIGHT_ARROW;
    case CONSOLE_SDK_INPUT_KEY_SHIFT: return DOOM_KEY_SHIFT;
    case CONSOLE_SDK_INPUT_KEY_CONTROL: return DOOM_KEY_CTRL;
    case CONSOLE_SDK_INPUT_KEY_ALT: return DOOM_KEY_ALT;
    case CONSOLE_SDK_INPUT_KEY_F1: return DOOM_KEY_F1;
    case CONSOLE_SDK_INPUT_KEY_F2: return DOOM_KEY_F2;
    case CONSOLE_SDK_INPUT_KEY_F3: return DOOM_KEY_F3;
    case CONSOLE_SDK_INPUT_KEY_F4: return DOOM_KEY_F4;
    case CONSOLE_SDK_INPUT_KEY_F5: return DOOM_KEY_F5;
    case CONSOLE_SDK_INPUT_KEY_F6: return DOOM_KEY_F6;
    case CONSOLE_SDK_INPUT_KEY_F7: return DOOM_KEY_F7;
    case CONSOLE_SDK_INPUT_KEY_F8: return DOOM_KEY_F8;
    case CONSOLE_SDK_INPUT_KEY_F9: return DOOM_KEY_F9;
    case CONSOLE_SDK_INPUT_KEY_F10: return DOOM_KEY_F10;
    case CONSOLE_SDK_INPUT_KEY_F11: return DOOM_KEY_F11;
    case CONSOLE_SDK_INPUT_KEY_F12: return DOOM_KEY_F12;
    case CONSOLE_SDK_INPUT_KEY_MINUS: return DOOM_KEY_MINUS;
    case CONSOLE_SDK_INPUT_KEY_EQUALS: return DOOM_KEY_EQUALS;
    case CONSOLE_SDK_INPUT_KEY_COMMA: return DOOM_KEY_COMMA;
    case CONSOLE_SDK_INPUT_KEY_PERIOD: return DOOM_KEY_PERIOD;
    case CONSOLE_SDK_INPUT_KEY_SLASH: return DOOM_KEY_SLASH;
    case CONSOLE_SDK_INPUT_KEY_SEMICOLON: return DOOM_KEY_SEMICOLON;
    case CONSOLE_SDK_INPUT_KEY_APOSTROPHE: return DOOM_KEY_APOSTROPHE;
    case CONSOLE_SDK_INPUT_KEY_LEFT_BRACKET: return DOOM_KEY_LEFT_BRACKET;
    case CONSOLE_SDK_INPUT_KEY_RIGHT_BRACKET: return DOOM_KEY_RIGHT_BRACKET;
    case CONSOLE_SDK_INPUT_KEY_PAUSE: return DOOM_KEY_PAUSE;
    default: return DOOM_KEY_UNKNOWN;
  }
}

static bool deliver_key(unsigned key, unsigned* budget) {
  if (wanted_keys[key] == delivered_keys[key]) return true;
  if (*budget == 0) return false;
  if (wanted_keys[key]) doom_key_down((doom_key_t)key);
  else doom_key_up((doom_key_t)key);
  delivered_keys[key] = wanted_keys[key];
  --*budget;
  return true;
}

static void read_keys(void) {
  // The engine does not consume events during wipes or calls that advance no
  // tics. Respect its actual remaining queue capacity, and retain key state
  // changes for the next frame so a deferred release cannot leave a key held.
  unsigned budget = (unsigned)(eventtail - eventhead - 1) & (MAXEVENTS - 1);
  if (budget > 32) budget = 32;
  if (is_wiping_screen) budget = 0;
  console_key_events events = console_input_read_events();
  for (size_t i = 0; i < events.len; ++i) {
    doom_key_t key = map_key(events.data[i].key);
    if (key == DOOM_KEY_UNKNOWN) continue;
    wanted_keys[key] = events.data[i].pressed != 0;
    deliver_key((unsigned)key, &budget);
  }
  console_input_free_events(&events);
  for (unsigned key = 0; key < 256 && budget; ++key)
    deliver_key(key, &budget);
  // The pointer turns the player; vertical motion never walks. Buttons map
  // to the engine's three.
  static uint32_t buttons;
  console_mouse mouse = console_input_mouse();
  if (mouse.dx) doom_mouse_move(mouse.dx * 4, 0);
  const uint32_t bits[] = {CONSOLE_SDK_INPUT_MOUSE_BUTTONS_LEFT, CONSOLE_SDK_INPUT_MOUSE_BUTTONS_RIGHT,
                           CONSOLE_SDK_INPUT_MOUSE_BUTTONS_MIDDLE};
  const doom_button_t engine[] = {DOOM_LEFT_BUTTON, DOOM_RIGHT_BUTTON, DOOM_MIDDLE_BUTTON};
  for (unsigned i = 0; i < 3; ++i) {
    bool down = (mouse.buttons & bits[i]) != 0;
    if (down == ((buttons & bits[i]) != 0)) continue;
    if (down) doom_button_down(engine[i]);
    else doom_button_up(engine[i]);
  }
  buttons = mouse.buttons;
}

#ifdef DOOM_TEST
static void append_number(char* message, const char* label, int value) {
  doom_concat(message, label);
  doom_concat(message, doom_itoa(value, 10));
}

static void report_state(void) {
  static unsigned frame_number;
  char message[512] = "doom-state";
  player_t* player = &players[consoleplayer];
  append_number(message, " frame=", (int)++frame_number);
  append_number(message, " tic=", gametic);
  append_number(message, " level=", gamestate == GS_LEVEL);
  append_number(message, " user=", usergame);
  append_number(message, " demo=", demoplayback);
  append_number(message, " map=", gamemap);
  append_number(message, " wipe=", is_wiping_screen);
  append_number(message, " x=", player->mo ? player->mo->x : 0);
  append_number(message, " y=", player->mo ? player->mo->y : 0);
  append_number(message, " angle=", player->mo ? (int)(player->mo->angle >> 16) : 0);
  append_number(message, " ammo=", player->ammo[am_clip]);
  append_number(message, " forward=", gamekeydown[DOOM_KEY_W]);
  append_number(message, " turn=", gamekeydown[DOOM_KEY_RIGHT_ARROW]);
  append_number(message, " fire=", gamekeydown[DOOM_KEY_SPACE]);
  console_log(CONSOLE_SDK_LOG_LEVEL_DEBUG, message, (size_t)doom_strlen(message));
}
#endif

void console_guest_init(void) {
  if (initialized) fail("PureDOOM can only be initialized once per component instance");
  initialized = true;
  doom_set_print(print_message);
  doom_set_malloc(allocate, console_free);
  doom_set_file_io(console_stream_open, console_stream_close, console_stream_read,
                   console_stream_write, seek_file, console_stream_tell,
                   console_stream_eof);
  doom_set_gettime(get_time);
  doom_set_exit(quit_game);
  doom_set_getenv(get_environment);

  doom_set_default_int("key_up", DOOM_KEY_W);
  doom_set_default_int("key_down", DOOM_KEY_S);
  doom_set_default_int("key_strafeleft", DOOM_KEY_A);
  doom_set_default_int("key_straferight", DOOM_KEY_D);
  doom_set_default_int("key_use", DOOM_KEY_E);
  doom_set_default_int("key_fire", DOOM_KEY_SPACE);
  doom_set_default_int("use_mouse", 1);
  doom_set_default_int("sfx_volume", 8);
  doom_set_default_int("music_volume", 0);

  uint32_t argc = console_process_arg_count();
  if (argc > 64) fail("PureDOOM accepts at most 64 arguments");
  char** argv = console_malloc((argc + 2) * sizeof(char*));
  if (!argc) {
    argv[0] = "doom";
    argc = 1;
  } else {
    for (uint32_t i = 0; i < argc; ++i) {
      console_string arg = console_process_arg(i);
      if (arg.len > 1023) fail("PureDOOM argument exceeds 1023 bytes");
      argv[i] = console_malloc(arg.len + 1);
      doom_memcpy(argv[i], arg.data, (int)arg.len);
      argv[i][arg.len] = '\0';
      console_free_string(&arg);
    }
  }
  argv[argc] = NULL;
  doom_init((int)argc, argv, DOOM_FLAG_HIDE_MOUSE_OPTIONS | DOOM_FLAG_HIDE_MUSIC_OPTIONS);
}

// The engine's indexed frame goes to the platform as it is, with its palette
// when that changes: a damage flash or a lit-up powerup.
static void present_frame(void) {
  extern unsigned char screen_palette[256 * 3];
  static unsigned char palette[256 * 3];
  static bool palette_set;
  if (!palette_set || memcmp(palette, screen_palette, sizeof palette) != 0) {
    uint8_t colors[256 * 4];
    for (unsigned i = 0; i < 256; ++i) {
      colors[4 * i] = screen_palette[3 * i];
      colors[4 * i + 1] = screen_palette[3 * i + 1];
      colors[4 * i + 2] = screen_palette[3 * i + 2];
      colors[4 * i + 3] = 255;
    }
    console_gfx_set_palette(0, colors, 256);
    memcpy(palette, screen_palette, sizeof palette);
    palette_set = true;
  }
  console_gfx_present_indexed(SCREENWIDTH, SCREENHEIGHT, doom_get_framebuffer(1),
                              SCREENWIDTH * SCREENHEIGHT);
}

// PureDOOM mixes 512 frames at 11025 Hz per call, each repeated four times
// for the platform's 44100 Hz; the queue is kept about a tenth of a second
// ahead of what the host plays.
static void pump_sound(void) {
  enum { CHUNK = 512, REPEAT = 4, AHEAD = 4096 };
  while (console_audio_queued() < AHEAD) {
    const short* mixed = doom_get_sound_buffer();
    int16_t samples[CHUNK * REPEAT * 2];
    for (unsigned i = 0; i < CHUNK; ++i) {
      for (unsigned k = 0; k < REPEAT; ++k) {
        samples[(i * REPEAT + k) * 2] = mixed[i * 2];
        samples[(i * REPEAT + k) * 2 + 1] = mixed[i * 2 + 1];
      }
    }
    if (console_audio_write(samples, CHUNK * REPEAT * 2) < CHUNK * REPEAT) break;
  }
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  if (!initialized) fail("PureDOOM frame called before initialization");
  read_keys();
  doom_update();
  pump_sound();
  present_frame();
#ifdef DOOM_TEST
  report_state();
#endif
  return 1;
}
