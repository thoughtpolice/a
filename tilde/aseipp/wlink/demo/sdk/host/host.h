// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_HOST_H
#define CONSOLE_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>


#ifdef __cplusplus
extern "C" {
#endif

typedef struct console_host console_host;

typedef struct {
  const char *name;
  const char *help;
  /* An optional application-specific flag, including its leading --. */
  const char *asset_option;
  bool asset_required;
  bool (*mount_asset)(console_host *, const char *path);
  /* Zero selects the default 60 Hz. Maximum supported rate is 1000 Hz. */
  unsigned frames_per_second;
} console_host_config;

/* Mount in the guest's virtual root. Ownership transfers on success; the
 * runner frees data at shutdown. On failure the caller retains ownership.
 * Names are unique virtual paths: slash-separated, no empty, ".", or ".."
 * segments. No host paths reach the guest. */
bool console_host_mount_readonly(console_host *, const char *name,
                                 uint8_t *data, size_t size);

/* Run the linked game/platform reactor with terminal or headless services.
 * Configuration and argument strings must remain valid until this returns.
 * With no asset_option, no host file is required to start the application. */
int console_host_run(const console_host_config *, int argc, char **argv);


#ifdef __cplusplus
}
#endif

#endif
