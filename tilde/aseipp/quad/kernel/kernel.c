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
//
// On macOS a process's windows must run on its main thread, AppKit's, so
// there Scheme runs on a thread of its own, and the main thread is the Rust
// half's (main_thread.rs): it runs the windows' event loop, once a window
// opens.
#define _GNU_SOURCE
#include "scheme.h"

#include "chez_embed.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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

#if defined(__APPLE__)
#include <pthread.h>
#include <spawn.h>
#include <sys/resource.h>
extern char** environ;
#endif

static void
fatal(const char* msg)
{
  fprintf(stderr, "quad: fatal: %s\n", msg);
  exit(70);
}

// The path of the running executable, which quad --build-exe copies.
static const char* g_self_path;

#if defined(__APPLE__)
// The command line, for Scheme's thread, which runs the editor.
static int g_ac;
static const char** g_argv;
#endif

// The Rust half's procedures (lib.rs).
void quad_native_register(void);
void quad_gui_settle(void);

#if defined(__APPLE__)
// Runs scheme on a thread with a stack of stack bytes, and gives the
// calling thread, the main one, to the windows (main_thread.rs).
_Noreturn void quad_main_thread_run(int (*scheme)(void), size_t stack);
#endif

// Descriptors the kernel makes are close-on-exec, so that the programs the
// editor runs inherit none of them: atomically on Linux, else as soon as
// they are made (macOS, which has no accept4, pipe2 or SOCK_CLOEXEC).
#if !defined(__linux__)
static int
cloexec(int fd)
{
  if (fd >= 0) fcntl(fd, F_SETFD, FD_CLOEXEC);
  return fd;
}
#endif

static int
unix_socket(void)
{
#if defined(__linux__)
  return socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
#else
  return cloexec(socket(AF_UNIX, SOCK_STREAM, 0));
#endif
}

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

// The window size in pixels as width * 65536 + height, or -1 where the
// terminal does not say.
int
quad_tty_pixels(int fd)
{
  struct winsize ws;
  if (ioctl(fd, TIOCGWINSZ, &ws) != 0 || ws.ws_xpixel == 0 || ws.ws_ypixel == 0) return -1;
  return ((int)ws.ws_xpixel << 16) | ws.ws_ypixel;
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
  int fd = unix_socket();
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
  int fd = unix_socket();
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
#if defined(__linux__)
  return accept4(fd, NULL, NULL, SOCK_CLOEXEC);
#else
  return cloexec(accept(fd, NULL, NULL));
#endif
}

int
quad_close(int fd)
{
  return close(fd);
}

// Fork a process to go on without the terminal, as a window does by
// default (main.sls): the child leaves the terminal's session, with its
// standard input, output and error on /dev/null, and keeps the write end
// of a pipe to tell the parent how opening its window went; the parent
// keeps the read end. Returns the child's pid in the parent, 0 in the
// child, or -1; *fd is the end of the pipe each keeps.
//
// On macOS the child is not a fork but a new quad, with the same arguments:
// the frameworks a window needs refuse to run in the child of a process
// that had threads, as every quad there does (Scheme's and the main one).
// It is told the pipe's write end in QUAD_DETACHED_FD, and its first call
// here returns 0 and that end, so that it goes on as a forked child would,
// from the same place.
#if defined(__APPLE__)
static int g_detached_fd = -1;

// The pipe to the parent of a process quad_fork_detached started, from
// QUAD_DETACHED_FD, which goes no further (to the programs the editor runs).
static void
take_detached_fd(void)
{
  const char* var = getenv("QUAD_DETACHED_FD");
  if (!var) return;
  char* end;
  long fd = strtol(var, &end, 10);
  if (*var && *end == '\0' && fd >= 0 && fd < INT_MAX && fcntl((int)fd, F_GETFD) >= 0)
    g_detached_fd = cloexec((int)fd);
  unsetenv("QUAD_DETACHED_FD");
}

int
quad_fork_detached(int* fd)
{
  if (g_detached_fd >= 0) {
    *fd = g_detached_fd;
    g_detached_fd = -1;
    return 0;
  }
  int p[2];
  if (pipe(p) != 0) return -1;
  cloexec(p[0]);
  cloexec(p[1]);
  // The environment, naming the child's end of the pipe.
  size_t n = 0;
  while (environ[n]) n++;
  char** env = calloc(n + 2, sizeof(char*));
  if (!env) {
    close(p[0]);
    close(p[1]);
    return -1;
  }
  char var[32];
  snprintf(var, sizeof(var), "QUAD_DETACHED_FD=%d", p[1]);
  size_t m = 0;
  for (size_t i = 0; i < n; i++)
    if (strncmp(environ[i], "QUAD_DETACHED_FD=", 17) != 0) env[m++] = environ[i];
  env[m++] = var;
  env[m] = NULL;
  // In a session of its own, its standard streams on /dev/null, and no
  // other descriptor of this process's but its end of the pipe.
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDWR, 0);
  posix_spawn_file_actions_adddup2(&actions, 0, 1);
  posix_spawn_file_actions_adddup2(&actions, 0, 2);
  posix_spawn_file_actions_addinherit_np(&actions, p[1]);
  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT);
  pid_t pid;
  int spawned = posix_spawn(&pid, g_self_path, &actions, &attrs, (char* const*)g_argv, env);
  posix_spawnattr_destroy(&attrs);
  posix_spawn_file_actions_destroy(&actions);
  free(env);
  close(p[1]);
  if (spawned != 0) {
    close(p[0]);
    return -1;
  }
  *fd = p[0];
  return pid;
}
#else
int
quad_fork_detached(int* fd)
{
  int p[2];
  if (pipe2(p, O_CLOEXEC) != 0) return -1;
  pid_t pid = fork();
  if (pid < 0) {
    close(p[0]);
    close(p[1]);
    return -1;
  }
  if (pid == 0) {
    close(p[0]);
    setsid();
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null >= 0) {
      dup2(null, 0);
      dup2(null, 1);
      dup2(null, 2);
      if (null > 2) close(null);
    }
    *fd = p[1];
    return 0;
  }
  close(p[1]);
  *fd = p[0];
  return pid;
}
#endif

const char*
quad_self_path(void)
{
  return g_self_path ? g_self_path : "";
}

// The machine's name, or "" if it has none.
const char*
quad_hostname(void)
{
  static char name[256];
  if (gethostname(name, sizeof(name)) != 0) name[0] = '\0';
  name[sizeof(name) - 1] = '\0';
  return name;
}

#if defined(__APPLE__)
// Whether macOS started this quad as an app, from Finder, the Dock or open:
// launchd, which starts every app, is then its parent.
static int g_app;

// macOS starts an app in /, wherever it was opened from: it starts in the
// home directory instead, as a terminal's shell does.
static void
start_at_home(void)
{
  char cwd[PATH_MAX];
  const char* home = getenv("HOME");
  if (home && *home && getcwd(cwd, sizeof(cwd)) && strcmp(cwd, "/") == 0)
    (void)chdir(home);
}
#endif

// 1 if macOS started this quad as an app, which has no terminal to detach
// from (core/main.sls), else 0.
int
quad_launched_as_app(void)
{
#if defined(__APPLE__)
  return g_app;
#else
  return 0;
#endif
}

#define ALLPRIMS(_) \
  _(quad_isatty)    \
  _(quad_tty_raw)   \
  _(quad_tty_restore) \
  _(quad_tty_size)  \
  _(quad_tty_pixels) \
  _(quad_read)      \
  _(quad_write)     \
  _(quad_take_winch) \
  _(quad_suspend)   \
  _(quad_self_path)   \
  _(quad_hostname)    \
  _(quad_launched_as_app) \
  _(quad_poll)        \
  _(quad_unix_listen) \
  _(quad_unix_connect) \
  _(quad_accept)      \
  _(quad_close)       \
  _(quad_fork_detached)

/* -------------------------------------------------------------------------- */
/* -- Entry point ----------------------------------------------------------- */

// Boots Chez Scheme from the boot files appended to the executable, and runs
// the editor; returns its exit status.
static int
run_scheme(int ac, const char* av[])
{
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
  quad_gui_settle();
  restore_at_exit();
  Sscheme_deinit();
  return result;
}

#if defined(__APPLE__)
// The signals as the main thread had them, before it blocked them.
static sigset_t g_signals;

// Scheme's thread. Signals for the process (a resize, a stop, ^C) come to
// it, as they do to the main thread where that is Scheme's: the main thread
// blocks them.
static int
scheme_thread(void)
{
  pthread_sigmask(SIG_SETMASK, &g_signals, NULL);
  return run_scheme(g_ac, g_argv);
}

// The stack the main thread would have, as Scheme's thread runs the C and
// Rust that Scheme calls, and the threads it starts: the stack limit, and
// at least 8 MiB (the limit's default), where a thread's is otherwise
// 512 KiB.
static size_t
scheme_stack_size(void)
{
  struct rlimit limit;
  size_t size = 8 << 20;
  if (getrlimit(RLIMIT_STACK, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY
      && limit.rlim_cur > size)
    size = limit.rlim_cur;
  return size;
}
#endif

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

#if defined(__APPLE__)
  g_ac = ac;
  g_argv = av;
  take_detached_fd();
  g_app = getppid() == 1;
  if (g_app) start_at_home();
  // Every signal for the process but those a fault raises in the thread
  // that faults.
  sigset_t blocked;
  sigfillset(&blocked);
  int faults[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SIGABRT, SIGSYS};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) sigdelset(&blocked, faults[i]);
  pthread_sigmask(SIG_BLOCK, &blocked, &g_signals);
  quad_main_thread_run(scheme_thread, scheme_stack_size());
#else
  return run_scheme(ac, av);
#endif
}
