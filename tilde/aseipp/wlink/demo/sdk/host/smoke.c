// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Exercise the SDK runner without any application asset requirement.
#include "host.h"

int main(int argc, char **argv) {
  const console_host_config config = {.name = "sdk-host-smoke"};
  return console_host_run(&config, argc, argv);
}
