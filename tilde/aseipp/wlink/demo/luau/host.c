// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The runner for a Luau cart. The cart is compiled into the application, so
// the console needs no asset of its own to start.
#include "host.h"

int main(int argc, char **argv) {
  const console_host_config config = {
      .name = "luau-console",
      .frames_per_second = 60,
  };
  return console_host_run(&config, argc, argv);
}
