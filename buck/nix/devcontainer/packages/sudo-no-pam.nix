# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.sudo.overrideAttrs (previousAttrs: {
  buildInputs = builtins.filter (input: input != pkgs.pam) previousAttrs.buildInputs;
  configureFlags = previousAttrs.configureFlags ++ [
    "--disable-nls"
    "--without-pam"
  ];
})
