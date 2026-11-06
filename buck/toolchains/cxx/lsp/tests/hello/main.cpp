// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A binary for the language server's smoke test, which looks up the
// definitions of the names main uses.

#include <cstdio>
#include <vector>

#include "greeting/greeting.h"
#include "greeting/version.h"

int main() {
  std::vector<std::string> names = {"world"};
  for (const auto &name : names) {
    std::printf("%s %d\n", greet(name).c_str(), GREETING_VERSION);
  }
  return 0;
}
