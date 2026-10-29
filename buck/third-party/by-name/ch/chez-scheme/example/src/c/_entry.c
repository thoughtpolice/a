/*
** _entry.c -- Scheme kernel and application entry point.
**
** SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
** SPDX-License-Identifier: BSD-3-Clause
*/
#define _GNU_SOURCE
#include "scheme.h"

#include "prelude.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#include <pthread.h>
#include <unistd.h>

#if defined(PLATFORM_LINUX)
#include <sched.h>
#endif

#if defined(PLATFORM_UNIX)
#include <sys/wait.h>
#endif

#ifndef NDEBUG
#define kdbg(...) fprintf(stderr, "[KERNEL] "__VA_ARGS__)
#define kdbg2(...) fprintf(stderr, __VA_ARGS__)
#else
#define kdbg(...)
#define kdbg2(...)
#endif

/**
 * fatal(fmt, ...):
 *
 * Emit a message to ${stderr}, signifying a fatal error, and exit the program.
 * The argument given in ${fmt} is a printf(3) compatible format string, along
 * with the remaining variable arguments in ${...}
*/
#define fatal(...)                                     \
  do {                                                 \
    fprintf(stderr, "\n[KERNEL] FATAL: " __VA_ARGS__); \
    exit(-1);                                          \
  } while (0)

/*
** RTS_BOOT_FILE is the name of the Chez runtime boot file. It could be
** petite.boot or scheme.boot, depending on if the user wants the native
** compiler.
*/
#ifndef RTS_BOOT_FILE
#error must define RTS_BOOT_FILE! build system failure?
#endif

/*
** APP_BOOT_FILE is the name of the application boot file to search for. By
** default, Sregister_boot_file will look in SCHEMEHEAPDIRS in order to find the
** given filename.
*/
#define APP_BOOT_FILE APP_NAME_STRING ".boot"

/* -------------------------------------------------------------------------- */
/* -- Custom heap initialization -------------------------------------------- */

/**
 * Sschemeapp_heap_init():
 *
 * Custom initialization function, called before any boot file is loaded.
 */
static void
Sschemeapp_heap_init(void)
{
  kdbg("heap_init()\n");
  return;
}

/* -------------------------------------------------------------------------- */
/* -- Useful functions to export directly to the runtime -------------------- */

/*
** A list of every kernel primitive exposed by the C kernel, to be used by the
** Scheme application. These functions are registered as C symbols using
** 'Sforeign_symbol', which can then be resolved inside Scheme using
** 'foreign-procedure'. You must only specify the name of the primitive below,
** as well as the implementation, for it to be in scope for 'foreign-procedure'.
**
** The primitive list is defined as a 2-stage X-macro. To generate code based on
** the list of supplied primitives, simply define a macro 'K' which takes one
** argument, the name of the primitive, and use 'ALLPRIMS(K)'. This will apply
** the macro 'K' in the place of the underscores in the definition of ALLPRIMS,
** generating whatever code you want from that. This can be used to generate
** lots of boilerplate without having to touch multiple call/use sites.
*/
#define ALLPRIMS(_)                             \
  _(breakpoint)                                 \
  _(thread_setname)                             \
  _(thread_setaffinity)                         \
  _(system_numcores)                            \
  _(system_waitpid_return)

/*
** Given the name of a primitive, return a String of the fully qualified name.
** You should use PRIMSTR(foo) to get a string representing the fully qualified
** name of the primitive 'foo'.
*/
#define PRIMSTR(fn) ("Sschemeapp_" #fn)

/*
** Given the name of a primitive, return an identifier representing the fully
** qualified name. You should use PRIMNM(foo) to refer to, the
** primitive 'foo' inside the C kernel.
*/
#define PRIMNM(fn) Sschemeapp_##fn

/*
** Define or call a primitive function. Use 'PRIM(foo, a, b, c)' to define a
** primitive function 'foo' taking arguments 'a', 'b' and 'c'. Or alternatively,
** in non-declaration setting, 'PRIM(foo, a, b, c)' is the act of calling the
** primitive 'foo' with arguments 'a' 'b' 'c'.
*/
#define PRIM(fn, ...) PRIMNM(fn)(__VA_ARGS__)

/* -------------------------------------------------------------------------- */

/**
 * Sschemeapp_breakpoint():
 *
 * Dummy function. Called after the user-given C initialization function.
 * Used primarily inside a C debugger to set a breakpoint after loading
 * dynamic libraries, so further breakpoints can be installed.
 */
static void
PRIM(breakpoint, void)
{
  kdbg("breakpoint: hit\n");
  return;
}

/**
 * Sschemeapp_thread_setname(name):
 *
 * Sets the name of the currently executing thread to the given string ${name}
 * and return. This function only works on Linux systems. On non-Linux systems
 * that do not support `pthread_setname_np`, this function does nothing.
 */
static void
PRIM(thread_setname, const char* name)
{
  (void)pthread_setname_np(pthread_self(), name);
  return;
}

/**
 * Sschemeapp_system_numcores():
 *
 * Get the number of cores available on the current system, and return it
 * as an int.
 */
static int
PRIM(system_numcores, void)
{
  return sysconf(_SC_NPROCESSORS_ONLN);
}

/**
 * Sschemeapp_thread_setaffinity(core):
 *
 * Set the affinity of the calling thread to the specified ${core}; this, in
 * effect, pins the thread to only run on ${core}. This is useful to stop
 * jitter introduced by kernel scheduling, causing interrupts/spurious core
 * migrations.
 *
 * Note that the given ${core} number must be in the range [0 ... ncores-1],
 * inclusive. That is, cores use 0-based indexing. Thus, calling this function
 * with the argument PRIM(thread_numcores) is an error, since it returns the
 * total number, which is not 0 based. PRIM(thread_numcores)-1 would be the last
 * core in your system and works correctly.
 *
 * Returns -3 if the function is not supported on this platform. Returns -2 if
 * the given input ${core} is less than zero, or greater than the number of
 * available cores on the system. Returns -1 upon error when calling
 * ${sched_setaffinity(2)} internally. Returns 0 upon success.
 */
static int
PRIM(thread_setaffinity, int core)
{
#if defined(PLATFORM_LINUX)
  cpu_set_t cpus;
  int numcores = PRIM(system_numcores);

  if ((core < 0) || (core >= numcores))
    return -2;

  CPU_ZERO(&cpus);
  CPU_SET(core, &cpus);
  return sched_setaffinity(0, sizeof(cpus), &cpus);
#else
  return -3;
#endif
}

static int
PRIM(system_waitpid_return, int proc)
{
#if defined(PLATFORM_UNIX)
  int status;

  waitpid(proc, &status, 0);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
#elif defined(PLATFORM_WINDOWS)
  return proc;
#else
#error unknown platform for waitpid_return!
#endif
}

/* -- End of kernel primitives ---------------------------------------------- */

/*
** A struct representing a kernel primitive, to be registered using
** 'Sforeign_symbol'. This contains both a pointer to the primitive (to be
** called by Scheme code), as well as the name to register inside the runtime.
** The given name can be bound to a Scheme function using '(foreign-procedure)'
*/
struct kernel_sym {
  const char* name;
  void* func;
};

/* A list of every kernel primitive defined above. Automatically generated. */
static struct kernel_sym g_ksyms[] = {
#define K(fn) {.name = PRIMSTR(fn), .func = PRIMNM(fn)},
    ALLPRIMS(K)
#undef K
};

#undef PRIM

/* -------------------------------------------------------------------------- */
/* -- Entry point ----------------------------------------------------------- */

/**
 * main(ac, av):
 *
 * Executable entry point. Boots the scheme kernel, loads the primary boot file,
 * and executes `scheme-start`. The scheme kernel is started with the arguments
 * specified in ${av} (excluding the program name, ${av[0]}), the number of
 * which is given by ${ac}.
 */
int
main(int ac, const char* av[])
{
  /* Start */
  kdbg("app " APP_NAME_STRING " " APP_VERSION_STRING "; booting kernel...");
  Sscheme_init(NULL);
  Sretain_static_relocation();
  kdbg2("ok, v%s\n", Skernel_version());

#ifndef NDEBUG
  Sset_verbose(1);
#endif

  /* Register boot file */
  bool boot_chez = NULL != getenv("RTS_BOOT_CHEZ");
  const char* bootfile = boot_chez ? RTS_BOOT_FILE : APP_BOOT_FILE;

  // clang-format off
  kdbg("searching for %s boot file %s...\n",
       boot_chez ? "chez runtime" : "app",
       bootfile);
  // clang-format on

  Sregister_boot_file(bootfile);
  kdbg("ok, boot file loaded.\n");

  /* Build heap */
  kdbg("Initializing heap...\n");
  Sbuild_heap(av[0], Sschemeapp_heap_init);
  kdbg("ok, done\n");

#ifdef FEATURE_EXPEDITOR
  /* Enable the expeditor if it's available. */
  kdbg("enabling expeditor...");
  Senable_expeditor(NULL);
  kdbg2("ok\n");
#endif

  /* Register internal symbols. */
  for (unsigned long i = 0; i < countof(g_ksyms); i++) {
    kdbg("registering symbol %s...", g_ksyms[i].name);
    Sforeign_symbol(g_ksyms[i].name, g_ksyms[i].func);
    kdbg2("ok\n");
  }

  /* Suppress greeting, and set the waiter prompt for booting into a cafe. */
#define CALL1(who, arg) Scall1(Stop_level_value(Sstring_to_symbol(who)), arg)
  CALL1("suppress-greeting", Strue);
  CALL1("waiter-prompt-string", Sstring(APP_NAME_STRING ">"));
#undef CALL1

  /* Run the main image. Sscheme_start skips the program name in av[0]. */
  int result = Sscheme_start(ac, av);

  /* Finished */
  kdbg("ok, done (r = %d)\n", result);
  kdbg("shutdown\n");
  Sscheme_deinit();
  return result;
}

/*
** Local Variables:
** mode: c
** fill-column: 80
** indent-tabs-mode: nil
** c-basic-offset: 2
** buffer-file-coding-system: utf-8-unix
** End:
*/
