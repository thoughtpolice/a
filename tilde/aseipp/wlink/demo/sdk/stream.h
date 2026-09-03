// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_STREAM_H
#define CONSOLE_STREAM_H


#ifdef __cplusplus
extern "C" {
#endif

// Seekable streams over the SDK's positional file resources. Each stream owns
// its file handle, cursor, and EOF state. Modes are r/rb (read) and w/wb (create/truncate).
// Counts and offsets use int for compatibility with small C libraries.
void* console_stream_open(const char* path, const char* mode);
void console_stream_close(void* file);
// Read/write return the byte count, or -1 on error before any progress.
int console_stream_read(void* file, void* buffer, int count);
int console_stream_write(void* file, const void* buffer, int count);
// Origin is 0 (start), 1 (current position), or 2 (end). Seek returns 0/-1.
int console_stream_seek(void* file, int offset, int origin);
// Tell returns -1 if the current position cannot be represented as int.
int console_stream_tell(void* file);
int console_stream_eof(void* file);


#ifdef __cplusplus
}
#endif

#endif
