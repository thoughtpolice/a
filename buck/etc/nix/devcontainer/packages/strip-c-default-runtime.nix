# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ stripElfFiles }:

previousAttrs:
(stripElfFiles previousAttrs)
// {
  postInstall = (previousAttrs.postInstall or "") + ''
    # The image deliberately fixes its locale to C.UTF-8. Retain English
    # diagnostics while omitting translation catalogs and unused manuals
    # from otherwise single-output command packages.
    rm -rf "$out/share/locale" "$out/share/man"
  '';
}
