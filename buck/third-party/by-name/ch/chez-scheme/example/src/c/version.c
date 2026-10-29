/*
** version.c -- the version string, as C sees it.
**
** SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
** SPDX-License-Identifier: BSD-3-Clause
*/
#ifndef APP_VERSION_STRING
#error No APP_VERSION_STRING defined!
#endif

char*
c_version(void)
{
  return APP_VERSION_STRING;
}
