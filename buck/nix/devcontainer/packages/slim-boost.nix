# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.boost.override {
  # Watchman uses Boost.Regex only for ordinary regular expressions. Avoid
  # retaining ICU solely for its optional Unicode locale backend.
  enableIcu = false;
}
