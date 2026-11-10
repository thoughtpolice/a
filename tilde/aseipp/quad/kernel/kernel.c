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
// opens.//
// The primitives themselves, and the process's setup around them, are the
// operating system's (os.h): os-unix.c on Linux and macOS, os-windows.c on
// Windows.
#include "scheme.h"

#include "chez_embed.h"
#include "os.h"

#include <stdio.h>
#include <stdlib.h>

static void
fatal(const char* msg)
{
  fprintf(stderr, "quad: fatal: %s\n", msg);
  exit(70);
}

const char* g_self_path;
int g_ac;
const char** g_argv;

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
  _(quad_rename)      \
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
  os_restore_terminal();
  Sscheme_deinit();
  return result;
}

// Scheme's thread.
static int
scheme_thread(void)
{
  os_scheme_thread();
  return run_scheme(g_ac, g_argv);
}

int
main(int ac, const char* av[])
{
  g_self_path = chez_embed_self_path(av[0]);
  if (!g_self_path) fatal("cannot locate the executable");
  g_ac = ac;
  g_argv = av;
  os_init();
  // Started to open a window: what it draws with is made while Scheme
  // boots, as it takes longer.
  if (os_detached()) quad_gui_prepare_early();
  os_before_main_thread();
  quad_main_thread_run(scheme_thread, os_scheme_stack_size());
}
