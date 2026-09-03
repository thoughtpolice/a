// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The SDK's <stdio.h> under the names C++ code expects.

#ifndef CONSOLE_CXX_CSTDIO
#define CONSOLE_CXX_CSTDIO

#include <stdio.h>

namespace std {

using ::FILE;
using ::size_t;

using ::clearerr;
using ::fclose;
using ::feof;
using ::ferror;
using ::fflush;
using ::fgetc;
using ::fgets;
using ::fopen;
using ::fputc;
using ::fputs;
using ::fread;
using ::fseek;
using ::ftell;
using ::fwrite;
using ::getc;
using ::putc;
using ::remove;
using ::rename;
using ::rewind;

using ::fprintf;
using ::printf;
using ::putchar;
using ::puts;
using ::snprintf;
using ::sprintf;
using ::sscanf;
using ::vfprintf;
using ::vprintf;
using ::vsnprintf;
using ::vsprintf;
using ::vsscanf;

using ::perror;

}  // namespace std

#endif
