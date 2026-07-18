# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.curlMinimal.override {
  gssSupport = false;
  scpSupport = false;
}
