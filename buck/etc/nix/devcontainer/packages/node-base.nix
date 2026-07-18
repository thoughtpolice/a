# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

let
  inherit (pkgs) lib;
in
pkgs.nodejs-slim.overrideAttrs (previousAttrs: {
  # The editor server ships its own full-ICU Node. The repository-facing
  # Node only needs ordinary Unicode and English Intl data; embedding small
  # ICU is substantially smaller than retaining the separate ICU closure.
  buildInputs = lib.filter (input: input != pkgs.icu) previousAttrs.buildInputs;
  configureFlags = map (
    flag: if flag == "--with-intl=system-icu" then "--with-intl=small-icu" else flag
  ) previousAttrs.configureFlags;
})
