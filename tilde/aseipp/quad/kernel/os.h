// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// os.h -- what the kernel (kernel.c) has of the operating system: the
// primitives Scheme calls through (quad kernel) (core/kernel.sls), and the
// process's setup around them. os-unix.c has them for Linux and macOS,
// os-windows.c for Windows.
//
// Scheme knows every stream it waits on -- the terminal, a connection, a
// pipe from the Rust half -- as an int, a "descriptor": on Unix a file
// descriptor, and on Windows a socket (os-windows.c says why).
#ifndef QUAD_OS_H
#define QUAD_OS_H

#include <stddef.h>

// The running executable, and the command line (kernel.c).
extern const char* g_self_path;
extern int g_ac;
extern const char** g_argv;

// The process, before Scheme: signals and the like (os_init); whether this
// process was started by quad_fork_detached, to open a window; and the main
// thread's last preparations before quad_main_thread_run takes it.
void os_init(void);
int os_detached(void);
void os_before_main_thread(void);

// On Scheme's thread, as it starts; and the stack it is given.
void os_scheme_thread(void);
size_t os_scheme_stack_size(void);

// Puts the terminal back as it was, if the editor left it raw.
void os_restore_terminal(void);

// The primitives (core/kernel.sls).
int quad_isatty(int fd);
int quad_tty_raw(int fd);
int quad_tty_restore(int fd);
int quad_tty_size(int fd);
int quad_tty_pixels(int fd);
int quad_read(int fd, unsigned char* buf, int n, int timeout_ms);
int quad_write(int fd, const unsigned char* buf, int n);
int quad_take_winch(void);
int quad_stop_requested(void);
void quad_suspend(void);
const char* quad_self_path(void);
const char* quad_hostname(void);
int quad_launched_as_app(void);
int quad_poll_rw(const int* fds, const int* events, int n, int timeout_ms, int* ready);
int quad_write_some(int fd, const unsigned char* buf, int start, int n);
int quad_unix_listen(const char* path);
int quad_unix_connect(const char* path);
int quad_accept(int fd);
int quad_private_dir(const char* path);
int quad_same_file(const char* a, const char* b);
int quad_lock(const char* path);
int quad_file_key(const char* path, char* out, int n);
int quad_close(int fd);
int quad_rename(const char* from, const char* to);
int quad_fork_detached(int* fd);

#endif
