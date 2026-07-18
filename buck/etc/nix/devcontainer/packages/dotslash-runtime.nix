# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.runCommand "devcontainer-dotslash-${pkgs.dotslash.version}"
  {
    nativeBuildInputs = [ pkgs.binutils ];
    inherit (pkgs.dotslash) meta;
    passthru.version = pkgs.dotslash.version;
  }
  ''
    install -Dm755 ${pkgs.dotslash}/bin/dotslash "$out/bin/dotslash"
    strip --strip-unneeded "$out/bin/dotslash"
  ''
