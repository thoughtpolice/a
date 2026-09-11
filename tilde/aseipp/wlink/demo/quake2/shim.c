// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The platform beneath quake2generic: the window the software renderer
// draws into, the clock, the keyboard, and the process, over the console
// SDK.
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "console.h"
#include "runtime.h"

// r_local.h brings in the engine's shared definitions that keys.h expects
// to find already declared.
#include "ref_soft/r_local.h"

#include "client/keys.h"
#include "quake2.h"
#include "quakegeneric.h"

#ifdef QUAKE2_TEST
void quake2_report_state(bool forward, bool turn, bool fire);
#endif

// The engine's key ring, drained once per frame; its capacity bounds how
// many transitions a frame may deliver.
extern int keyq_head;
extern int keyq_tail;

#define KEY_RING 64
#define MAX_ARGUMENTS 64

static uint8_t* framebuffer;
static int width;
static int height;

typedef struct {
  int key;
  bool down;
} transition;

static transition pending[256];
static unsigned pending_count;
static bool delivered[256];

int QG_Milliseconds(void) {
  return (int)console_clock_now_ms();
}

// Pointer motion in frame pixels, scaled to the engine's mouse units.
static int mouse_dx;
static int mouse_dy;
static uint32_t mouse_buttons;

void QG_GetMouseDiff(int* dx, int* dy) {
  *dx = mouse_dx;
  *dy = mouse_dy;
  mouse_dx = 0;
  mouse_dy = 0;
}

void QG_CaptureMouse(void) {
  console_input_capture_pointer(true);
}

void QG_ReleaseMouse(void) {
  console_input_capture_pointer(false);
}

int SWimp_Init(void* instance, void* window_procedure) {
  (void)instance;
  (void)window_procedure;
  return true;
}

void SWimp_Shutdown(void) {
  console_free(framebuffer);
  framebuffer = NULL;
  vid.buffer = NULL;
}

rserr_t SWimp_SetMode(int* pwidth, int* pheight, int mode, qboolean fullscreen) {
  (void)fullscreen;
  int new_width;
  int new_height;
  if (!ri.Vid_GetModeInfo(&new_width, &new_height, mode)) {
    ri.Con_Printf(PRINT_ALL, "SWimp_SetMode: invalid mode %d\n", mode);
    return rserr_invalid_mode;
  }
  SWimp_Shutdown();
  width = new_width;
  height = new_height;
  framebuffer = console_malloc((size_t)width * (size_t)height);
  memset(framebuffer, 0, (size_t)width * (size_t)height);
  vid.buffer = framebuffer;
  vid.rowbytes = width;
  *pwidth = width;
  *pheight = height;
  ri.Vid_NewWindow(width, height);
  return rserr_ok;
}

// 256 entries of red, green, blue, and padding with gamma already applied.
void SWimp_SetPalette(const unsigned char* colors) {
  if (!colors) colors = sw_state.currentpalette;
  uint8_t palette[256 * 4];
  for (int i = 0; i < 256; i++) {
    palette[4 * i] = colors[4 * i];
    palette[4 * i + 1] = colors[4 * i + 1];
    palette[4 * i + 2] = colors[4 * i + 2];
    palette[4 * i + 3] = 255;
  }
  console_gfx_set_palette(0, palette, 256);
}

void SWimp_BeginFrame(float camera_separation) {
  (void)camera_separation;
}

void SWimp_EndFrame(void) {
  if (!framebuffer) return;
  console_gfx_present_indexed((uint32_t)width, (uint32_t)height, framebuffer,
                              (size_t)width * (size_t)height);
}

void SWimp_AppActivate(qboolean active) {
  (void)active;
}

static int map_key(uint32_t key) {
  if (key >= CONSOLE_SDK_INPUT_KEY_A && key <= CONSOLE_SDK_INPUT_KEY_Z) return 'a' + (int)(key - CONSOLE_SDK_INPUT_KEY_A);
  if (key >= CONSOLE_SDK_INPUT_KEY_NUM0 && key <= CONSOLE_SDK_INPUT_KEY_NUM9) return '0' + (int)(key - CONSOLE_SDK_INPUT_KEY_NUM0);
  if (key >= CONSOLE_SDK_INPUT_KEY_F1 && key <= CONSOLE_SDK_INPUT_KEY_F12) return K_F1 + (int)(key - CONSOLE_SDK_INPUT_KEY_F1);
  switch (key) {
    case CONSOLE_SDK_INPUT_KEY_TAB: return K_TAB;
    case CONSOLE_SDK_INPUT_KEY_ENTER: return K_ENTER;
    case CONSOLE_SDK_INPUT_KEY_ESCAPE: return K_ESCAPE;
    case CONSOLE_SDK_INPUT_KEY_SPACE: return K_SPACE;
    case CONSOLE_SDK_INPUT_KEY_BACKSPACE: return K_BACKSPACE;
    case CONSOLE_SDK_INPUT_KEY_UP: return K_UPARROW;
    case CONSOLE_SDK_INPUT_KEY_DOWN: return K_DOWNARROW;
    case CONSOLE_SDK_INPUT_KEY_LEFT: return K_LEFTARROW;
    case CONSOLE_SDK_INPUT_KEY_RIGHT: return K_RIGHTARROW;
    case CONSOLE_SDK_INPUT_KEY_SHIFT: return K_SHIFT;
    case CONSOLE_SDK_INPUT_KEY_CONTROL: return K_CTRL;
    case CONSOLE_SDK_INPUT_KEY_ALT: return K_ALT;
    case CONSOLE_SDK_INPUT_KEY_MINUS: return '-';
    case CONSOLE_SDK_INPUT_KEY_EQUALS: return '=';
    case CONSOLE_SDK_INPUT_KEY_COMMA: return ',';
    case CONSOLE_SDK_INPUT_KEY_PERIOD: return '.';
    case CONSOLE_SDK_INPUT_KEY_SLASH: return '/';
    case CONSOLE_SDK_INPUT_KEY_SEMICOLON: return ';';
    case CONSOLE_SDK_INPUT_KEY_APOSTROPHE: return '\'';
    case CONSOLE_SDK_INPUT_KEY_LEFT_BRACKET: return '[';
    case CONSOLE_SDK_INPUT_KEY_RIGHT_BRACKET: return ']';
    case CONSOLE_SDK_INPUT_KEY_BACKSLASH: return '\\';
    case CONSOLE_SDK_INPUT_KEY_GRAVE: return '`';
    case CONSOLE_SDK_INPUT_KEY_PAUSE: return K_PAUSE;
    case CONSOLE_SDK_INPUT_KEY_INSERT: return K_INS;
    case CONSOLE_SDK_INPUT_KEY_DELETE: return K_DEL;
    case CONSOLE_SDK_INPUT_KEY_HOME: return K_HOME;
    case CONSOLE_SDK_INPUT_KEY_END: return K_END;
    case CONSOLE_SDK_INPUT_KEY_PAGE_UP: return K_PGUP;
    case CONSOLE_SDK_INPUT_KEY_PAGE_DOWN: return K_PGDN;
    case CONSOLE_SDK_INPUT_KEY_KP0: return K_KP_INS;
    case CONSOLE_SDK_INPUT_KEY_KP1: return K_KP_END;
    case CONSOLE_SDK_INPUT_KEY_KP2: return K_KP_DOWNARROW;
    case CONSOLE_SDK_INPUT_KEY_KP3: return K_KP_PGDN;
    case CONSOLE_SDK_INPUT_KEY_KP4: return K_KP_LEFTARROW;
    case CONSOLE_SDK_INPUT_KEY_KP5: return K_KP_5;
    case CONSOLE_SDK_INPUT_KEY_KP6: return K_KP_RIGHTARROW;
    case CONSOLE_SDK_INPUT_KEY_KP7: return K_KP_HOME;
    case CONSOLE_SDK_INPUT_KEY_KP8: return K_KP_UPARROW;
    case CONSOLE_SDK_INPUT_KEY_KP9: return K_KP_PGUP;
    case CONSOLE_SDK_INPUT_KEY_KP_ENTER: return K_KP_ENTER;
    case CONSOLE_SDK_INPUT_KEY_KP_PERIOD: return K_KP_DEL;
    case CONSOLE_SDK_INPUT_KEY_KP_PLUS: return K_KP_PLUS;
    case CONSOLE_SDK_INPUT_KEY_KP_MINUS: return K_KP_MINUS;
    case CONSOLE_SDK_INPUT_KEY_KP_MULTIPLY: return '*';
    case CONSOLE_SDK_INPUT_KEY_KP_DIVIDE: return K_KP_SLASH;
    default: return -1;
  }
}

static void deliver(transition t, unsigned* budget) {
  if (*budget) {
    Quake2_SendKey(t.key, t.down);
    delivered[t.key & 255] = t.down;
    --*budget;
  } else if (pending_count < sizeof pending / sizeof pending[0]) {
    pending[pending_count++] = t;
  }
}

// Transitions the ring cannot take this frame wait for the next one in
// order, so a release is never dropped behind its press.
static void read_keys(void) {
  unsigned budget = KEY_RING - 1 - (unsigned)((keyq_head - keyq_tail) & (KEY_RING - 1));
  transition waiting[sizeof pending / sizeof pending[0]];
  unsigned waiting_count = pending_count;
  memcpy(waiting, pending, waiting_count * sizeof waiting[0]);
  pending_count = 0;
  for (unsigned i = 0; i < waiting_count; i++) deliver(waiting[i], &budget);
  console_key_events events = console_input_read_events();
  for (size_t i = 0; i < events.len; i++) {
    int key = map_key(events.data[i].key);
    if (key < 0) continue;
    deliver((transition){key, events.data[i].pressed != 0}, &budget);
  }
  console_input_free_events(&events);
  // The pointer: four engine units per frame pixel, the buttons as the
  // engine's mouse keys, and each wheel notch as a press and a release.
  console_mouse mouse = console_input_mouse();
  mouse_dx += mouse.dx * 4;
  mouse_dy += mouse.dy * 4;
  const uint32_t bits[] = {CONSOLE_SDK_INPUT_MOUSE_BUTTONS_LEFT, CONSOLE_SDK_INPUT_MOUSE_BUTTONS_RIGHT,
                           CONSOLE_SDK_INPUT_MOUSE_BUTTONS_MIDDLE};
  for (unsigned i = 0; i < 3; i++) {
    bool down = (mouse.buttons & bits[i]) != 0;
    if (down != ((mouse_buttons & bits[i]) != 0)) deliver((transition){K_MOUSE1 + (int)i, down}, &budget);
  }
  mouse_buttons = mouse.buttons;
  for (int notch = mouse.wheel; notch != 0; notch += notch > 0 ? -1 : 1) {
    int key = notch > 0 ? K_MWHEELUP : K_MWHEELDOWN;
    deliver((transition){key, true}, &budget);
    deliver((transition){key, false}, &budget);
  }
}

static char* copy_argument(console_string text) {
  char* copy = console_malloc(text.len + 1);
  memcpy(copy, text.data, text.len);
  copy[text.len] = '\0';
  console_free_string(&text);
  return copy;
}

void console_guest_init(void) {
  // Settings come first so the caller's own +commands win, and so that a
  // +set of the caller's, coming later in the same list, overrides one of
  // these. freelook is the console's own default rather than the engine's:
  // the stock one aims with the mouse only while a +mlook key is held, and
  // this engine never registers that command, so without it there is no way
  // to look up or down with the pointer at all -- pushing the mouse forward
  // and back walks the player instead.
  static char* const defaults[] = {
      "quake2",
      "+set", "vid_ref", "soft",
      "+set", "sw_mode", "0",
      "+set", "vid_fullscreen", "0",
      "+set", "freelook", "1",
  };
  uint32_t count = console_process_arg_count();
  if (count > MAX_ARGUMENTS) count = MAX_ARGUMENTS;
  int fixed = (int)(sizeof defaults / sizeof defaults[0]);
  char** argv = console_malloc(((size_t)fixed + count + 2) * sizeof *argv);
  int argc = 0;
  for (int i = 0; i < fixed; i++) argv[argc++] = defaults[i];
  bool commanded = false;
  for (uint32_t i = 0; i < count; i++) {
    argv[argc] = copy_argument(console_process_arg(i));
    commanded |= argv[argc][0] == '+' && strcmp(argv[argc], "+set") != 0;
    argc++;
  }
  // Without a command of the caller's the engine plays its attract demos,
  // which predate the protocol it speaks, and the error ends the game; the
  // console opens the menu instead.
  if (!commanded) argv[argc++] = "+menu_main";
  argv[argc] = NULL;
  Quake2_Init(argc, argv);
  // Late commands cannot carry these: the engine splits them at every plus
  // sign. The buffer runs them on the first frame, after the caller's own
  // commands, so a config of the caller's still overrides them.
  Cbuf_AddText("bind w +forward\nbind s +back\nbind a +moveleft\nbind d +moveright\n"
               "bind SPACE +attack\nbind e +moveup\nbind c +movedown\n");
}

int32_t console_guest_frame(uint32_t dt_ms) {
  read_keys();
  Quake2_Frame((int)dt_ms);
#ifdef QUAKE2_TEST
  quake2_report_state(delivered['w'], delivered[K_RIGHTARROW], delivered[K_SPACE]);
#endif
  return 1;
}
