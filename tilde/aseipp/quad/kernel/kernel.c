// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// kernel.c -- the C kernel of quad: boots Chez Scheme from the boot files
// appended to its own executable (toolchains//chez:embed), registers the
// primitives the Scheme side cannot express itself -- the terminal and
// connection ones here -- and the Rust half's procedures, (quad native)
// (lib.rs). Everything else, the editor included, is Scheme. The executable
// allocates with mimalloc, which overrides malloc for C, Chez Scheme and Rust
// alike.
//
// quad --build-exe writes new executables the same way the build does: this
// kernel, then boot files (see toolchains//chez's embed.sls).
#define _GNU_SOURCE
#include "scheme.h"

#include "chez_embed.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

static void
fatal(const char* msg)
{
  fprintf(stderr, "quad: fatal: %s\n", msg);
  exit(70);
}

// The path of the running executable, which quad --build-exe copies.
static const char* g_self_path;

// The Rust half's procedures (lib.rs).
void quad_native_register(void);

/* -------------------------------------------------------------------------- */
/* -- Terminal primitives --------------------------------------------------- */

static struct termios g_saved_termios;
static int g_raw_fd = -1;
static volatile sig_atomic_t g_winch = 0;

static void
on_winch(int sig)
{
  (void)sig;
  g_winch = 1;
}

// After a stop, the size may have changed: treat it as a resize.
static void
on_cont(int sig)
{
  (void)sig;
  g_winch = 1;
}

// Restore the terminal: the Scheme side does it on every orderly exit, and
// this catches the rest (exit from an uncaught error, for one).
static void
restore_at_exit(void)
{
  if (g_raw_fd >= 0) {
    // Leave the alternate screen, pop the keyboard mode, and show the cursor.
    static const char reset[] =
        "\x1b[<u\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[0 q\x1b[?1049l";
    (void)!write(g_raw_fd, reset, sizeof(reset) - 1);
    tcsetattr(g_raw_fd, TCSAFLUSH, &g_saved_termios);
    g_raw_fd = -1;
  }
}

int
quad_isatty(int fd)
{
  return isatty(fd);
}

int
quad_tty_raw(int fd)
{
  struct termios t;
  if (tcgetattr(fd, &g_saved_termios) != 0) return -1;
  t = g_saved_termios;
  t.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
  t.c_oflag &= ~(OPOST);
  t.c_cflag |= CS8;
  t.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
  t.c_cc[VMIN] = 0;
  t.c_cc[VTIME] = 0;
  if (tcsetattr(fd, TCSAFLUSH, &t) != 0) return -1;
  if (g_raw_fd < 0) {
    static int registered = 0;
    if (!registered) {
      atexit(restore_at_exit);
      registered = 1;
    }
  }
  g_raw_fd = fd;
  return 0;
}

int
quad_tty_restore(int fd)
{
  g_raw_fd = -1;
  return tcsetattr(fd, TCSAFLUSH, &g_saved_termios);
}

// The window size as rows * 65536 + cols, or -1.
int
quad_tty_size(int fd)
{
  struct winsize ws;
  if (ioctl(fd, TIOCGWINSZ, &ws) != 0 || ws.ws_col == 0) return -1;
  return ((int)ws.ws_row << 16) | ws.ws_col;
}

// Wait up to timeout_ms (forever if negative) for input, then read up to n
// bytes into buf. Returns the count read, 0 on timeout, -2 if interrupted by
// a signal (a resize, say), and -1 on error or end of file.
int
quad_read(int fd, unsigned char* buf, int n, int timeout_ms)
{
  struct pollfd p = {.fd = fd, .events = POLLIN};
  int r = poll(&p, 1, timeout_ms);
  if (r < 0) return errno == EINTR ? -2 : -1;
  if (r == 0) return 0;
  ssize_t got = read(fd, buf, n);
  if (got < 0) return (errno == EINTR || errno == EAGAIN) ? -2 : -1;
  if (got == 0) return -1;
  return (int)got;
}

// Write all of buf[0..n), returning n or -1.
int
quad_write(int fd, const unsigned char* buf, int n)
{
  int done = 0;
  while (done < n) {
    ssize_t r = write(fd, buf + done, n - done);
    if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (r <= 0) return -1;
    done += r;
  }
  return n;
}

// Returns and clears the resize flag.
int
quad_take_winch(void)
{
  int w = g_winch;
  g_winch = 0;
  return w;
}

// Stop the process, as ^Z would; returns after SIGCONT.
void
quad_suspend(void)
{
  kill(0, SIGTSTP);
}

/* -------------------------------------------------------------------------- */
/* -- Connections ----------------------------------------------------------- */

// Clients reach the editor over byte streams. The server polls every
// descriptor it serves -- the terminal, the listening socket, each client's
// connection -- through quad_poll. Other transports (Iroh, from the Rust half)
// join by handing Scheme a descriptor for each stream, a socketpair end.

// Wait up to timeout_ms (forever if negative) for any of fds[0..n) to be
// readable, hung up or in error; ready[i] is set to 1 for each that is.
// Returns the number ready, 0 on timeout, -2 if interrupted, -1 on error.
int
quad_poll(const int* fds, int n, int timeout_ms, int* ready)
{
  struct pollfd ps[256];
  if (n > 256) n = 256;
  for (int i = 0; i < n; i++) {
    ps[i].fd = fds[i];
    ps[i].events = POLLIN;
    ps[i].revents = 0;
  }
  int r = poll(ps, n, timeout_ms);
  for (int i = 0; i < n; i++)
    ready[i] = (r > 0 && (ps[i].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) ? 1 : 0;
  if (r < 0) return errno == EINTR ? -2 : -1;
  return r;
}

static int
unix_address(const char* path, struct sockaddr_un* addr)
{
  memset(addr, 0, sizeof(*addr));
  addr->sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr->sun_path)) return -1;
  strcpy(addr->sun_path, path);
  return 0;
}

// Listen on a Unix socket at path, which must not exist; returns the
// listening descriptor, or -1.
int
quad_unix_listen(const char* path)
{
  struct sockaddr_un addr;
  if (unix_address(path, &addr) != 0) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0 || listen(fd, 16) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

// Connect to the Unix socket at path; returns the descriptor, or -1.
int
quad_unix_connect(const char* path)
{
  struct sockaddr_un addr;
  if (unix_address(path, &addr) != 0) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

int
quad_accept(int fd)
{
  return accept4(fd, NULL, NULL, SOCK_CLOEXEC);
}

int
quad_close(int fd)
{
  return close(fd);
}

const char*
quad_self_path(void)
{
  return g_self_path ? g_self_path : "";
}

#define ALLPRIMS(_) \
  _(quad_isatty)    \
  _(quad_tty_raw)   \
  _(quad_tty_restore) \
  _(quad_tty_size)  \
  _(quad_read)      \
  _(quad_write)     \
  _(quad_take_winch) \
  _(quad_suspend)   \
  _(quad_self_path)   \
  _(quad_poll)        \
  _(quad_unix_listen) \
  _(quad_unix_connect) \
  _(quad_accept)      \
  _(quad_close)

/* -------------------------------------------------------------------------- */
/* -- Entry point ----------------------------------------------------------- */

int
main(int ac, const char* av[])
{
  g_self_path = chez_embed_self_path(av[0]);
  if (!g_self_path) fatal("cannot locate the executable");

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_winch;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGWINCH, &sa, NULL);
  sa.sa_handler = on_cont;
  sigaction(SIGCONT, &sa, NULL);
  // A client that goes away makes writes to it fail, rather than kill us.
  signal(SIGPIPE, SIG_IGN);

  Sscheme_init(NULL);
  if (chez_embed_register(g_self_path) < 0)
    fatal("no boot files are appended to this executable");
  Sbuild_heap(av[0], NULL);

#define K(fn) Sforeign_symbol(#fn, (void*)fn);
  ALLPRIMS(K)
#undef K
  quad_native_register();

  // The program's scheme-start, which the last boot file set, runs the
  // editor; Sscheme_start skips the program name in av[0].
  int result = Sscheme_start(ac, av);
  restore_at_exit();
  Sscheme_deinit();
  return result;
}
