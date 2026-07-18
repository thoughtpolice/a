# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.glibc.overrideAttrs (previousAttrs: {
  postInstall = (previousAttrs.postInstall or "") + ''
    # C.UTF-8 is installed independently under lib/locale. The image fixes
    # that locale globally, so localedef's source/charmap corpus and
    # translated libc diagnostics are runtime-dead weight.
    rm -rf "$out/share/i18n" "$out/share/locale"
  '';
})
