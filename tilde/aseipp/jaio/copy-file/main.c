// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/* --------------------------------------------------------------- */

#define _GNU_SOURCE

// libc
#include <assert.h>
#include <ctype.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>

// glibc
#include <argp.h>
#include <err.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <syslog.h>
#include <sys/types.h>
#include <sys/stat.h>

// external
#include <liburing.h>
#include <mimalloc.h>

// local
#include "util/macros.h"
#include "util/log.h"
#include "util/file_size.h"
#include "util/vsb.h"
#include "util/co.h"

#include "io/ring.h"
#include "io/async.h"

/* -------------------------------------------------------------------------- */
/* -- Copy file coroutine --------------------------------------------------- */

struct cookie {
  struct ring* ring;
  int bsize;
};

void
copy_file(void)
{
  int ret = EXIT_FAILURE;
  struct cookie* c = coro_cookie();

  void *buf = mi_malloc(c->bsize);
  off_t off = 0;

  do {
    ssize_t bytes_read = await_read(c->ring, 0, buf, c->bsize, off, IOSQE_FIXED_FILE);
    if (bytes_read < 0) {
      perror("await_readv");
      goto exit;
    }

    if (bytes_read == 0) {
      // EOL, we wrote a perfectly aligned block last time
      ret = EXIT_SUCCESS;
      goto exit;
    }

    if (await_write(c->ring, 1, buf, bytes_read, off, IOSQE_FIXED_FILE) != bytes_read) {
      perror("await_writev");
      goto exit;
    }


    off += bytes_read;
    if (bytes_read < c->bsize) {
      // short write: we just wrote the last block
      ret = EXIT_SUCCESS;
      goto exit;
    }

  } while (1);

exit:
  mi_free(buf);
  coro_return(ret);
}

// startup(input, output, qd, bsize): currently this is a simple file copy
// routine, which copies a file from the path specified in ${input} to the one
// in ${output}. ${qd} controls the queue depth size for an underlying io_uring
// instance, while ${bsize} controls the block size used for read/write
// routines.
int
startup(char *input, char* output, unsigned int qd, int bsize)
{
  // Open files
  int ifd = open(input, O_RDONLY);
  if (ifd < 0) err(EXIT_FAILURE, "open(2)");

  int ofd = open(output, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (ofd < 0) err(EXIT_FAILURE, "open(2)");

  // Build the ring and get the total file size
  off_t insize;
  struct ring ring;
  int fds[2] = { ifd, ofd };

  file_size(ifd, &insize);
  if (NULL == ring_new(&ring, qd, fds, 2, NULL))
    err(EXIT_FAILURE, "ring_new");

  // Build coroutine parameters. Note: we don't need to include the file
  // descriptors in the cookie, because they're already registered with the
  // underlying io_uring. We instead refer to them by their fixed indicies
  // using IOSQE_FIXED_FILE in the submission entry.
  struct cookie c = {
    .ring = &ring,
    .bsize = bsize,
  };

  // Now, run the coroutine, and once it returns, begin dispatching events
  int ret = EXIT_FAILURE;
  struct coro* co = coro_autonew(4096*4, copy_file, &c);
  // NB: maybe coro creation should have an 'autostart' flag?
  coro_switch(co);

  // The core event loop. Termination criteria: we exit when the coroutine
  // tells us to.
  do {
    if (coro_done(co)) break;

    // dispatch SQEs, and resume the resp CQE coroutine
    if (dispatch_cqe(&ring) != 0)
      err(EXIT_FAILURE, "io_uring(2)");
  } while (1);

  // Done
  ret = co->ret;
  coro_destroy(&co);
  ring_delete(&ring);

  close(ifd);
  close(ofd);

  return ret;
}

/* --------------------------------------------------------------- */
/* -- Driver: parsing and other initialization gunk -------------- */

const char* argp_program_version = "copy-file 1.0pre";
const char* argp_program_bug_address = "<aseipp@pobox.com>";
static char doc[] = "cp(1) clone";
static char args_doc[] = "INFILE OUTFILE";

static struct argp_option options[] = {
  { "loglvl",    'l', "LEVEL", 0, "Set the logging level (debug/info/err)", 0 },
  { "qdepth",    'd', "DEPTH", 0, "Set queue depth for the ring", 0 },
  { "blocksize", 'b', "BYTES", 0, "Set block queue size", 0 },
  { 0 },
};

struct arguments
{
  char* log_level;
  int queue_depth;
  int block_size;
  char* files[2];
};

static error_t
parse_opt(int key, char* arg, struct argp_state* st)
{
  struct arguments* args = st->input;

  switch (key) {
    case 'l':
      args->log_level = arg;
      break;

    case 'd':
      args->queue_depth = atoi(arg);
      if (args->queue_depth <= 0)
        argp_usage(st);
      break;

    case 'b':
      args->block_size = atoi(arg);
      if (args->block_size <= 0)
        argp_usage(st);
      break;

    case ARGP_KEY_ARG:
      if (st->arg_num >= 2)
        argp_usage(st);

      args->files[st->arg_num] = arg;
      break;

    case ARGP_KEY_END:
      if (st->arg_num < 2) // file args are mandatory
        argp_usage(st);

      break;

    default:
      return ARGP_ERR_UNKNOWN;
  }

  return 0;
}

int
main(int ac, char** av)
{
  struct arguments args;
  struct argp argp = { options, parse_opt, args_doc, doc, 0, 0, 0 };

  args.log_level = "err";
  args.queue_depth = 32;
  args.block_size = 32 * 1024;
  args.files[0] = NULL;
  args.files[1] = NULL;

  argp_parse(&argp, ac, av, 0, 0, &args);
  init_log(args.log_level);

  return startup(
    args.files[0],
    args.files[1],
    args.queue_depth,
    args.block_size
  );
}

// vim: ai ts=2 sts=2 sw=2 ft=c expandtab
