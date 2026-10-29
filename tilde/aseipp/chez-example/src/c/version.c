// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// version.c -- the version string, as C sees it.
#ifndef APP_VERSION_STRING
#error No APP_VERSION_STRING defined!
#endif

char*
c_version(void)
{
  return APP_VERSION_STRING;
}
