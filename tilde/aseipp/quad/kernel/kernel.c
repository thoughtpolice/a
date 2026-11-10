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
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

#include <pthread.h>
#include <spawn.h>
#include <sys/resource.h>
extern char** environ;

static void
fatal(const char* msg)
{
  fprintf(stderr, "quad: fatal: %s\n", msg);
  exit(70);
}

// The path of the running executable, which quad --build-exe copies.
static const char* g_self_path;

// The command line, for Scheme's thread, which runs the editor.
static int g_ac;
static const char** g_argv;

// The Rust half's procedures (lib.rs).
void quad_native_register(void);
void quad_gui_settle(void);
void quad_mesh_settle(void);

// Runs scheme on a thread with a stack of stack bytes, and gives the
// calling thread, the main one, to the windows (main_thread.rs).
_Noreturn void quad_main_thread_run(int (*scheme)(void), size_t stack);

// Starts making what the first window draws with (render/), before Scheme
// boots: in a process started to open a window (quad_fork_detached).
void quad_gui_prepare_early(void);

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

// A pipe, both its ends close-on-exec.
static int
cloexec_pipe(int p[2])
{
#if defined(__linux__)
  return pipe2(p, O_CLOEXEC);
#else
  if (pipe(p) != 0) return -1;
  cloexec(p[0]);
  cloexec(p[1]);
  return 0;
#endif
}

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
static volatile sig_atomic_t g_stop = 0;

// A pipe each signal handler writes a byte to, which quad_poll_rw and quad_read
// wait on too: a signal wakes them whichever thread it lands on (the
// Rust half's threads, Scheme's, or the main one), where EINTR only reaches
// the thread it interrupts.
static int g_signal_pipe[2] = {-1, -1};

static void
signal_pipe_open(void)
{
  if (cloexec_pipe(g_signal_pipe) != 0) {
    g_signal_pipe[0] = g_signal_pipe[1] = -1;
    return;
  }
  for (int i = 0; i < 2; i++) {
    fcntl(g_signal_pipe[i], F_SETFL, fcntl(g_signal_pipe[i], F_GETFL) | O_NONBLOCK);
  }
}

static void
signal_wake(void)
{
  int saved = errno;
  if (g_signal_pipe[1] >= 0) (void)!write(g_signal_pipe[1], "", 1);
  errno = saved;
}

// Empties the pipe, once a wait has woken for it.
static void
signal_drain(void)
{
  char buf[64];
  while (g_signal_pipe[0] >= 0 && read(g_signal_pipe[0], buf, sizeof(buf)) > 0) {}
}

// A resize; or, after a stop (SIGCONT), the size may have changed: treat
// it as one.
static void
on_winch(int sig)
{
  (void)sig;
  g_winch = 1;
  signal_wake();
}

// SIGTERM or SIGHUP: the editor is asked to stop, which it does as it would
// when told to quit, saying goodbye to its clients (those over iroh learn
// at once, rather than when their connection times out). A second one,
// with the editor too busy to stop, ends the process as the signal would.
static void
on_stop(int sig)
{
  if (g_stop) {
    signal(sig, SIG_DFL);
    raise(sig);
    return;
  }
  g_stop = 1;
  signal_wake();
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

int quad_poll_rw(const int* fds, const int* events, int n, int timeout_ms, int* ready);

// Wait up to timeout_ms (forever if negative) for input, then read up to n
// bytes into buf (quad_poll_rw's wait). Returns the count read, 0 on
// timeout, -2 if interrupted by a signal (a resize, say), and -1 on error or
// end of file.
int
quad_read(int fd, unsigned char* buf, int n, int timeout_ms)
{
  int readable = 1, ready = 0;
  int r = quad_poll_rw(&fd, &readable, 1, timeout_ms, &ready);
  if (r <= 0) return r;
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

// 1 once the editor is asked to stop (SIGTERM, SIGHUP), else 0.
int
quad_stop_requested(void)
{
  return g_stop;
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
// connection -- through quad_poll_rw. Other transports (Iroh, from the Rust half)
// join by handing Scheme a descriptor for each stream, a socketpair end.

// Wait up to timeout_ms (forever if negative) for any of fds[0..n) to be
// ready as events[i] asks: 1, readable (or hung up, or in error); 2,
// writable; 3, either. ready[i] is set to what each is, likewise. Returns
// the number ready, 0 on timeout, -2 if interrupted, -1 on error.
int
quad_poll_rw(const int* fds, const int* events, int n, int timeout_ms, int* ready)
{
  // As many as there are: the editor's clients, and its language servers,
  // are not limited.
  struct pollfd small[65];
  struct pollfd* ps = n < 65 ? small : malloc((size_t)(n + 1) * sizeof(struct pollfd));
  if (!ps) return -1;
  for (int i = 0; i < n; i++) {
    ps[i].fd = fds[i];
    ps[i].events = (short)(((events[i] & 1) ? POLLIN : 0) | ((events[i] & 2) ? POLLOUT : 0));
    ps[i].revents = 0;
  }
  // The signal pipe, last.
  ps[n].fd = g_signal_pipe[0];
  ps[n].events = POLLIN;
  ps[n].revents = 0;
  int r = poll(ps, (nfds_t)n + 1, timeout_ms);
  int saved = errno;
  int count = 0;
  for (int i = 0; i < n; i++) {
    short re = r > 0 ? ps[i].revents : 0;
    int gone = (re & (POLLHUP | POLLERR | POLLNVAL)) != 0;
    ready[i] = (((events[i] & 1) && ((re & POLLIN) || gone)) ? 1 : 0)
               | (((events[i] & 2) && ((re & POLLOUT) || gone)) ? 2 : 0);
    count += ready[i] != 0;
  }
  int signaled = r > 0 && ps[n].revents;
  if (ps != small) free(ps);
  if (r < 0) return saved == EINTR ? -2 : -1;
  if (signaled) {
    signal_drain();
    if (count == 0) return -2;
  }
  return count;
}

// Write what of buf[start..start+n) a socket takes now, without waiting:
// the count written (0 if it takes none now), or -1 on error.
int
quad_write_some(int fd, const unsigned char* buf, int start, int n)
{
  for (;;) {
    ssize_t r = send(fd, buf + start, (size_t)n, MSG_DONTWAIT);
    if (r >= 0) return (int)r;
    if (errno == EINTR) continue;
    return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
  }
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

// 1 if path is a directory that is this user's alone: no symbolic link,
// owned by the effective user, with no access for anyone else. Sockets go
// only in such a directory, where nobody else can put one of their own.
int
quad_private_dir(const char* path)
{
  struct stat st;
  if (lstat(path, &st) != 0) return 0;
  return S_ISDIR(st.st_mode) && st.st_uid == geteuid() && (st.st_mode & 077) == 0;
}

// 1 if paths a and b name the same file (a socket, say), however each is
// spelled: through links, relatively, or with "..".
int
quad_same_file(const char* a, const char* b)
{
  struct stat sa, sb;
  if (stat(a, &sa) != 0 || stat(b, &sb) != 0) return 0;
  return sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

// Takes the lock at path (a file made if need be), waiting for whoever has
// it: the descriptor that holds it, which closing gives back, or -1.
int
quad_lock(const char* path)
{
  int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  while (flock(fd, LOCK_EX) != 0) {
    if (errno != EINTR) {
      close(fd);
      return -1;
    }
  }
  return fd;
}

// What file path is, as "device:inode" (written to out, of n bytes): to
// tell later whether path is still that file. Its length, or -1 if there is
// none.
int
quad_file_key(const char* path, char* out, int n)
{
  struct stat st;
  if (stat(path, &st) != 0) return -1;
  int w = snprintf(out, (size_t)n, "%llu:%llu", (unsigned long long)st.st_dev,
                   (unsigned long long)st.st_ino);
  return w < 0 || w >= n ? -1 : w;
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
// The child is not a fork but a new quad, with the same arguments: a
// fork would have only the thread that forked, Scheme's, and not the main
// one, which windows run on (main_thread.rs); and on macOS, the frameworks
// a window needs refuse to run in the child of a process that had threads.
// It is told the pipe's write end in QUAD_DETACHED_FD, and its first call
// here returns 0 and that end, so that it goes on as a forked child would,
// from the same place.
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
  if (*var && *end == '\0' && fd >= 0 && fd < INT_MAX && fcntl((int)fd, F_GETFD) >= 0) {
    g_detached_fd = (int)fd;
    fcntl(g_detached_fd, F_SETFD, FD_CLOEXEC);
  }
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
  if (cloexec_pipe(p) != 0) return -1;
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
  // In a session of its own, its standard streams on /dev/null, and its
  // end of the pipe: on macOS no other descriptor of this process's; on
  // Linux, none that is close-on-exec, as the kernel's and the Rust half's
  // all are. (A dup2 of a descriptor to itself clears close-on-exec, as
  // POSIX has it and glibc does since 2.29.)
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDWR, 0);
  posix_spawn_file_actions_adddup2(&actions, 0, 1);
  posix_spawn_file_actions_adddup2(&actions, 0, 2);
  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
#if defined(__APPLE__)
  posix_spawn_file_actions_addinherit_np(&actions, p[1]);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT);
#else
  posix_spawn_file_actions_adddup2(&actions, p[1], p[1]);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSID);
#endif
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
  _(quad_stop_requested) \
  _(quad_suspend)   \
  _(quad_self_path)   \
  _(quad_hostname)    \
  _(quad_launched_as_app) \
  _(quad_poll_rw)     \
  _(quad_write_some)  \
  _(quad_unix_listen) \
  _(quad_unix_connect) \
  _(quad_accept)      \
  _(quad_private_dir) \
  _(quad_same_file)   \
  _(quad_lock)        \
  _(quad_file_key)    \
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
  quad_mesh_settle();
  quad_gui_settle();
  restore_at_exit();
  Sscheme_deinit();
  return result;
}

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

int
main(int ac, const char* av[])
{
  g_self_path = chez_embed_self_path(av[0]);
  if (!g_self_path) fatal("cannot locate the executable");
  signal_pipe_open();

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_winch;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGWINCH, &sa, NULL);
  sigaction(SIGCONT, &sa, NULL);
  sa.sa_handler = on_stop;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  // A client that goes away makes writes to it fail, rather than kill us.
  signal(SIGPIPE, SIG_IGN);

  g_ac = ac;
  g_argv = av;
  take_detached_fd();
  // Started to open a window: what it draws with is made while Scheme
  // boots, as it takes longer.
  if (g_detached_fd >= 0) quad_gui_prepare_early();
#if defined(__APPLE__)
  g_app = getppid() == 1;
  if (g_app) start_at_home();
#endif
  // Every signal for the process but those a fault raises in the thread
  // that faults.
  sigset_t blocked;
  sigfillset(&blocked);
  int faults[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SIGABRT, SIGSYS};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) sigdelset(&blocked, faults[i]);
  pthread_sigmask(SIG_BLOCK, &blocked, &g_signals);
  quad_main_thread_run(scheme_thread, scheme_stack_size());
}
