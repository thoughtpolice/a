# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.tzdata.overrideAttrs (previousAttrs: {
  postInstall = (previousAttrs.postInstall or "") + ''
    rm -rf "$out/share/zoneinfo/right"
  '';
})
