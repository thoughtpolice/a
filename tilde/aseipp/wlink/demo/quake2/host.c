// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The native runner for Quake II: mounts a pak file where the engine looks
// for it and lets the SDK drive the rest.
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"

static uint32_t load32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static bool mount_pak(console_host *host, const char *path) {
  FILE *input = fopen(path, "rb");
  if (!input) {
    perror(path);
    return false;
  }
  bool ok = false;
  uint8_t *data = NULL;
  if (fseek(input, 0, SEEK_END)) goto done;
  long size = ftell(input);
  if (size < 12 || size > INT32_MAX || fseek(input, 0, SEEK_SET)) goto done;
  data = malloc((size_t)size);
  if (!data || fread(data, 1, (size_t)size, input) != (size_t)size || memcmp(data, "PACK", 4)) goto done;
  uint32_t directory = load32(data + 4);
  uint32_t length = load32(data + 8);
  if (length % 64 || length / 64 > 4096 || (uint64_t)directory + length > (uint64_t)size) goto done;
  bool colormap = false;
  for (uint32_t offset = 0; offset < length; offset += 64) {
    const uint8_t *entry = data + directory + offset;
    if (!memchr(entry, 0, 56) || (uint64_t)load32(entry + 56) + load32(entry + 60) > (uint64_t)size) goto done;
    colormap |= !strcmp((const char *)entry, "pics/colormap.pcx");
  }
  if (!colormap) goto done;
  if (!console_host_mount_readonly(host, "baseq2/pak0.pak", data, (size_t)size)) goto done;
  data = NULL;
  ok = true;
done:
  free(data);
  fclose(input);
  if (!ok) fprintf(stderr, "%s: not a Quake II pak with the base graphics\n", path);
  return ok;
}

int main(int argc, char **argv) {
  const console_host_config config = {
      .name = "quake2",
      .help = "WASD move, mouse aim, arrows turn, Space fire, E jump, C crouch, Esc menu, Ctrl-C quit.\n"
              "Guest arguments follow --, for example -- +map base1\n",
      .asset_option = "--pak",
      .asset_required = true,
      .mount_asset = mount_pak,
      .frames_per_second = 60,
  };
  return console_host_run(&config, argc, argv);
}
