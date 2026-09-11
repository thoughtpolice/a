// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// One line per frame with the server's view of the player, for the
// end-to-end test: where it is, where it looks, and which of the scripted
// keys the engine has been told about. A file of its own because the
// engine's server headers cannot share a translation unit with the
// renderer's.
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "console.h"

#include "server/server.h"

void quake2_report_state(bool forward, bool turn, bool fire);

void quake2_report_state(bool forward, bool turn, bool fire) {
  static unsigned frame;
  edict_t* player = NULL;
  int spawned = 0;
  if (sv.state == ss_game && svs.clients) {
    player = svs.clients[0].edict;
    spawned = svs.clients[0].state == cs_spawned;
  }
  const float* origin = player ? player->s.origin : (const float[3]){0, 0, 0};
  int yaw = player && player->client ? (int)player->client->ps.viewangles[YAW] : 0;
  int pitch = player && player->client ? (int)player->client->ps.viewangles[PITCH] : 0;
  int health = player && player->client ? player->client->ps.stats[STAT_HEALTH] : 0;
  char message[256];
  int length = snprintf(message, sizeof message,
                        "quake2-state frame=%u state=%d spawned=%d map=%s x=%d y=%d z=%d yaw=%d "
                        "pitch=%d health=%d forward=%d turn=%d fire=%d",
                        ++frame, (int)sv.state, spawned, sv.name[0] ? sv.name : "-",
                        (int)(origin[0] * 8), (int)(origin[1] * 8), (int)(origin[2] * 8), yaw,
                        pitch, health, forward, turn, fire);
  console_log(CONSOLE_SDK_LOG_LEVEL_DEBUG, message, (size_t)length);
}
