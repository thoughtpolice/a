// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include "host.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t load32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static bool mount_iwad(console_host *host, const char *path) {
  FILE *input = fopen(path, "rb");
  if (!input) { perror(path); return false; }
  bool ok = false;
  uint8_t *data = NULL;
  if (fseek(input, 0, SEEK_END)) goto done;
  long size = ftell(input);
  if (size < 12 || size > INT32_MAX || fseek(input, 0, SEEK_SET)) goto done;
  data = malloc((size_t)size);
  if (!data || fread(data, 1, (size_t)size, input) != (size_t)size || memcmp(data, "IWAD", 4)) goto done;
  uint32_t count = load32(data + 4), directory = load32(data + 8);
  if ((uint64_t)directory + (uint64_t)count * 16 > (uint64_t)size) goto done;
  bool map01 = false, e1 = false, e2 = false, e4 = false;
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t *entry = data + directory + 16 * (size_t)i;
    if ((uint64_t)load32(entry) + load32(entry + 4) > (uint64_t)size) goto done;
    const char *name = (const char *)entry + 8;
    map01 |= !memcmp(name, "MAP01\0\0\0", 8);
    e1 |= !memcmp(name, "E1M1\0\0\0\0", 8);
    e2 |= !memcmp(name, "E2M1\0\0\0\0", 8);
    e4 |= !memcmp(name, "E4M1\0\0\0\0", 8);
  }
  if (!map01 && !e1) goto done;
  const char *name = map01 ? "doom2.wad" : e4 ? "doomu.wad" : e2 ? "doom.wad" : "doom1.wad";
  if (!console_host_mount_readonly(host, name, data, (size_t)size)) goto done;
  data = NULL;
  ok = true;
done:
  free(data);
  fclose(input);
  if (!ok) fprintf(stderr, "%s: invalid or unsupported IWAD\n", path);
  return ok;
}

int main(int argc, char **argv) {
  const console_host_config config = {
    .name = "doom",
    .help = "WASD move, arrows turn, Space fire, E use, Esc menu, Ctrl-C quit.\n",
    .asset_option = "--iwad",
    .asset_required = true,
    .mount_asset = mount_iwad,
    .frames_per_second = 35,
  };
  return console_host_run(&config, argc, argv);
}
