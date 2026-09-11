// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The engine's system layer, in place of quakegeneric's q_system.c: the
// console, the key queue, the clock, and a directory search over the SDK's
// listing. The original leaves the search unimplemented, and the save system
// copies and wipes slots through it.
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "console.h"

#include "server/server.h"

#include "client/keys.h"
#include "other/glob.h"
#include "quake2.h"
#include "quakegeneric.h"

#define K_LAST 256
#define KEY_RING 64

static unsigned char key_states[K_LAST];

struct {
  int key;
  int down;
} keyq[KEY_RING];

int keyq_head;
int keyq_tail;

static cvar_t* nostdout;
extern cvar_t* vid_fullscreen;

unsigned sys_frame_time;
int curtime;

void Sys_ConsoleOutput(char* string) {
  if (nostdout && nostdout->value) return;
  fputs(string, stdout);
}

void Sys_Quit(void) {
  CL_Shutdown();
  Qcommon_Shutdown();
  _Exit(0);
}

void Sys_Init(void) {
  memset(key_states, 0, sizeof key_states);
}

void Sys_Error(char* error, ...) {
  va_list arguments;
  char text[1024];
  CL_Shutdown();
  Qcommon_Shutdown();
  va_start(arguments, error);
  vsnprintf(text, sizeof text, error, arguments);
  va_end(arguments);
  fprintf(stderr, "Error: %s\n", text);
  _Exit(1);
}

char* Sys_ConsoleInput(void) {
  return NULL;
}

void Sys_UnloadGame(void) {}

static void (*read_game)(char* filename);

// The server records each client's edict when the game initializes, and a
// loaded game allocates its entities afresh: with the C library's own
// allocator the block moves, where the original's would come back at the
// same address. The pointers are taken again once the game is read.
static void read_game_and_relink(char* filename) {
  read_game(filename);
  for (int i = 0; i < (int)maxclients->value; i++) svs.clients[i].edict = EDICT_NUM(i + 1);
}

void* Sys_GetGameAPI(void* parms) {
  extern game_export_t* GetGameAPI(game_import_t*);
  game_export_t* api = GetGameAPI(parms);
  read_game = api->ReadGame;
  api->ReadGame = read_game_and_relink;
  return api;
}

void Sys_AppActivate(void) {}

char* Sys_GetClipboardData(void) {
  return NULL;
}

void Sys_CopyProtect(void) {}

int Sys_Milliseconds(void) {
  curtime = QG_Milliseconds();
  return curtime;
}

static void process_key(int key, qboolean down) {
  if (key >= 0 && key < K_LAST) key_states[key] = down ? 1 : 0;
  Key_Event(key, down, Sys_Milliseconds());
  if (key_states[K_ALT] && key == K_ENTER && down) {
    Cvar_SetValue("vid_fullscreen", vid_fullscreen->value ? 0 : 1);
  }
}

void Sys_SendKeyEvents(void) {
  static bool draining;
  if (!draining) {
    draining = true;
    while (keyq_head != keyq_tail) {
      process_key(keyq[keyq_tail].key, keyq[keyq_tail].down);
      keyq_tail = (keyq_tail + 1) & (KEY_RING - 1);
    }
    draining = false;
  }
  sys_frame_time = Sys_Milliseconds();
}

void Sys_Mkdir(char* path) {
  console_files_create_directory(path, strlen(path));
}

// A search names a directory and a pattern for its entries, the way the
// Unix port takes them: the directory is listed once and the matches are
// handed out one per call, prefixed with the directory again.
static char find_base[2 * MAX_OSPATH];
static char find_pattern[2 * MAX_OSPATH];
static char find_path[4 * MAX_OSPATH];
static console_file_entries find_entries;
static size_t find_next;
static bool finding;

static bool attributes_match(const console_file_entry* entry, unsigned musthave, unsigned canthave) {
  if (entry->directory && (canthave & SFF_SUBDIR)) return false;
  return !(musthave & SFF_SUBDIR) || entry->directory;
}

char* Sys_FindNext(unsigned musthave, unsigned canthave) {
  while (find_next < find_entries.len) {
    const console_file_entry* entry = &find_entries.ptr[find_next++];
    char name[2 * MAX_OSPATH];
    if (entry->name.len >= sizeof name) continue;
    memcpy(name, entry->name.ptr, entry->name.len);
    name[entry->name.len] = '\0';
    if (!glob_match(find_pattern, name) || !attributes_match(entry, musthave, canthave)) continue;
    snprintf(find_path, sizeof find_path, "%s/%s", find_base, name);
    return find_path;
  }
  return NULL;
}

char* Sys_FindFirst(char* path, unsigned musthave, unsigned canthave) {
  if (finding) Sys_Error("Sys_BeginFind without close");
  finding = true;
  snprintf(find_base, sizeof find_base, "%s", path);
  char* slash = strrchr(find_base, '/');
  if (slash) {
    *slash = '\0';
    snprintf(find_pattern, sizeof find_pattern, "%s", slash + 1);
  } else {
    strcpy(find_pattern, "*");
  }
  if (!strcmp(find_pattern, "*.*")) strcpy(find_pattern, "*");
  find_next = 0;
  if (!console_files_list_directory(find_base, strlen(find_base), &find_entries)) return NULL;
  return Sys_FindNext(musthave, canthave);
}

void Sys_FindClose(void) {
  console_files_free_entries(&find_entries);
  finding = false;
}

void Quake2_Init(int argc, char** argv) {
  keyq_head = 0;
  keyq_tail = 0;
  memset(keyq, 0, sizeof keyq);
  Qcommon_Init(argc, argv);
  nostdout = Cvar_Get("nostdout", "0", 0);
}

void Quake2_Frame(int msec) {
  Qcommon_Frame(msec);
}

int Quake2_Milliseconds(void) {
  return Sys_Milliseconds();
}

void Quake2_SendKey(int key, qboolean down) {
  keyq[keyq_head].key = key;
  keyq[keyq_head].down = down;
  keyq_head = (keyq_head + 1) & (KEY_RING - 1);
}
