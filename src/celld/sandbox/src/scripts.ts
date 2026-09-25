// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The POSIX shell scripts behind the file and process operations.
 *
 * Each is a constant: arguments reach it as positional parameters
 * (`sh -c SCRIPT celld-sandbox WORKSPACE ARGS...`), never by splicing text
 * into the script, so nothing a caller sends is parsed by a shell. They
 * run with busybox (the recommended images) and with dash and GNU
 * coreutils (the test fake), and use only `realpath`, `dirname`, `find`,
 * `stat`, `wc`, `head`, `tail`, `mkfifo`, `setsid` and shell builtins.
 *
 * Paths are always absolute (the caller joins them to the workspace), so
 * no argument can be mistaken for an option.
 *
 * Exit statuses from 90 up are the scripts' own verdicts; `EXIT_CODES`
 * maps them to error codes.
 *
 * @module
 */

/** A script's own exit statuses and the error code each means. */
export const EXIT_CODES: Record<number, string> = {
  90: "no_workspace",
  91: "invalid_path",
  92: "outside_workspace",
  93: "not_found",
  94: "is_directory",
  95: "not_directory",
  96: "exists",
  97: "too_large",
  98: "not_regular",
  99: "not_empty",
};

// `$1` is the workspace. `guard P` resolves the deepest existing ancestor
// of P (P itself when it exists), following symbolic links, and refuses it
// unless it is the workspace or inside it. A dangling link is refused.
const PRELUDE = `set -u
w=$(realpath "$1" 2> /dev/null) || { echo "the workspace does not exist: $1" >&2; exit 90; }
shift
inside() { case "$1" in "$w"|"$w"/*) return 0;; esac; return 1; }
guard() {
  p=$1
  while [ ! -e "$p" ]; do
    if [ -L "$p" ]; then echo "a symbolic link points nowhere: $p" >&2; exit 91; fi
    p=$(dirname "$p")
  done
  r=$(realpath "$p" 2> /dev/null) || { echo "cannot resolve: $p" >&2; exit 91; }
  inside "$r" || { echo "the path leaves the workspace: $1" >&2; exit 92; }
}
`;

/** `READ PATH MAX`: the file's bytes on stdout, or 97 with its size on stderr. */
export const READ = PRELUDE + `
guard "$1"
[ -e "$1" ] || { echo "no such file: $1" >&2; exit 93; }
[ -d "$1" ] && { echo "is a directory: $1" >&2; exit 94; }
[ -f "$1" ] || { echo "not a regular file: $1" >&2; exit 98; }
s=$(wc -c < "$1")
s=$((s + 0))
[ "$s" -gt "$2" ] && { echo "$s" >&2; exit 97; }
exec cat "$1"
`;

/**
 * `WRITE PATH PARENTS MODE MAX`: stdin into PATH through a temporary file
 * and a rename, so readers never see half a file. PARENTS is 1 to create
 * missing directories; MODE is octal or "-"; more than MAX bytes is 97.
 * An existing symbolic link at PATH is replaced, not followed.
 */
export const WRITE = PRELUDE + `
d=$(dirname "$1")
guard "$d"
if [ "$2" = 1 ]; then mkdir -p "$d" || exit 1; guard "$d"; fi
[ -d "$d" ] || { echo "not a directory: $d" >&2; exit 95; }
guard "$1"
if [ -d "$1" ] && [ ! -L "$1" ]; then echo "is a directory: $1" >&2; exit 94; fi
t="$d/.celld-write-$$"
trap 'rm -f "$t"' EXIT
head -c $(($4 + 1)) > "$t" || exit 1
s=$(wc -c < "$t")
[ $((s + 0)) -gt "$4" ] && { echo "more than $4 bytes" >&2; exit 97; }
if [ "$3" != - ]; then chmod "$3" "$t" || exit 1; fi
mv -f "$t" "$1" || exit 1
trap - EXIT
`;

/** `MKDIR PATH RECURSIVE`. */
export const MKDIR = PRELUDE + `
guard "$1"
if [ -e "$1" ] || [ -L "$1" ]; then
  if [ -d "$1" ] && [ "$2" = 1 ]; then exit 0; fi
  echo "already exists: $1" >&2; exit 96
fi
if [ "$2" = 1 ]; then
  mkdir -p "$1"
else
  [ -d "$(dirname "$1")" ] || { echo "no parent directory: $1" >&2; exit 95; }
  mkdir "$1"
fi
`;

/**
 * `REMOVE PATH MODE`: MODE `file` removes a file or link only; `empty`
 * also an empty directory; `tree` a directory and everything in it. Links
 * are removed, never followed.
 */
export const REMOVE = PRELUDE + `
guard "$(dirname "$1")"
if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo "no such file: $1" >&2; exit 93; fi
if [ -d "$1" ] && [ ! -L "$1" ]; then
  case "$2" in
    file) echo "is a directory: $1" >&2; exit 94;;
    empty) rmdir "$1" 2> /dev/null || { echo "the directory is not empty: $1" >&2; exit 99; };;
    *) rm -rf "$1";;
  esac
else
  rm -f "$1"
fi
`;

/** `RENAME FROM TO`: refuses to replace a directory. */
export const RENAME = PRELUDE + `
guard "$(dirname "$1")"
guard "$(dirname "$2")"
if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo "no such file: $1" >&2; exit 93; fi
[ -d "$(dirname "$2")" ] || { echo "no parent directory: $2" >&2; exit 95; }
if [ -d "$2" ] && [ ! -L "$2" ]; then echo "the target is a directory: $2" >&2; exit 94; fi
mv -f "$1" "$2"
`;

/** `STAT PATH`: `KIND LINK SIZE MTIME`, following links (LINK is 1 for one). */
export const STAT = PRELUDE + `
guard "$1"
[ -e "$1" ] || { echo "no such file: $1" >&2; exit 93; }
l=0; [ -L "$1" ] && l=1
if [ -d "$1" ]; then k=dir; elif [ -f "$1" ]; then k=file; else k=other; fi
printf '%s %s %s\\n' "$k" "$l" "$(stat -L -c '%s %Y' "$1")"
`;

/**
 * `LIST DIR RECURSIVE HIDDEN`: NUL-separated records. A one-letter record
 * (`d`, `f`, `l`) starts the entries of that type; every other record is a
 * `./`-relative path. Hidden entries are pruned unless HIDDEN is 1.
 */
export const LIST = PRELUDE + `
guard "$1"
if [ ! -d "$1" ]; then
  [ -e "$1" ] && { echo "not a directory: $1" >&2; exit 95; }
  echo "no such directory: $1" >&2; exit 93
fi
cd "$1" || exit 1
depth=
[ "$2" = 1 ] || depth="-maxdepth 1"
for t in d f l; do
  printf '%s\\0' "$t"
  if [ "$3" = 1 ]; then
    find . -mindepth 1 $depth -type "$t" -print0
  else
    find . -mindepth 1 $depth -name '.*' -prune -o -type "$t" -print0
  fi
done
`;

/**
 * `SPAWN DIR MAX TIMEOUT CWD ARGV...` starts ARGV detached, in its own
 * session when `setsid` exists, and prints its pid. Its stdout and stderr
 * go through FIFOs into DIR/stdout and DIR/stderr, each capped at MAX bytes
 * rounded up to 512 (a file size limit on the reader alone; the rest is read
 * and dropped, so the process never blocks on a full pipe). `cat` is the
 * reader because it writes what it reads at once, where GNU `head -c`
 * would hold output back until its buffer fills. When it ends, DIR/exit holds its status; TIMEOUT seconds (0 for
 * none) later it is killed and DIR/timedout exists.
 */
export const SPAWN = `set -u
d=$1; b=$((($2 + 511) / 512)); t=$3
cd "$4" || { echo "cannot enter $4" >&2; exit 95; }
shift 4
mkdir -p "$d" && mkfifo "$d/o" "$d/e" || exit 1
(
  ( trap '' XFSZ; ulimit -f "$b"; cat > "$d/stdout"; cat > /dev/null ) < "$d/o" &
  r1=$!
  ( trap '' XFSZ; ulimit -f "$b"; cat > "$d/stderr"; cat > /dev/null ) < "$d/e" &
  r2=$!
  if command -v setsid > /dev/null 2>&1; then
    setsid "$@" > "$d/o" 2> "$d/e" < /dev/null &
  else
    "$@" > "$d/o" 2> "$d/e" < /dev/null &
  fi
  c=$!
  echo "$c" > "$d/pid.tmp" && mv "$d/pid.tmp" "$d/pid"
  k=
  if [ "$t" -gt 0 ]; then
    ( sleep "$t"; : > "$d/timedout"; kill -s KILL -- "-$c" 2> /dev/null || kill -s KILL "$c" 2> /dev/null ) &
    k=$!
  fi
  wait "$c"
  s=$?
  [ -n "$k" ] && kill "$k" 2> /dev/null
  wait "$r1" "$r2"
  rm -f "$d/o" "$d/e"
  echo "$s" > "$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"
) > /dev/null 2>&1 < /dev/null &
n=0
while [ ! -e "$d/pid" ]; do
  n=$((n + 1))
  [ "$n" -gt 1000 ] && { echo "the process did not start" >&2; exit 1; }
  sleep 0.01
done
cat "$d/pid"
`;

/**
 * `POLL DIR OUT ERR MAX`: a header line `EXIT TIMEDOUT SIZEOUT SIZEERR`
 * (EXIT is `-` while running; the line is `missing` without DIR; the sizes
 * are the files' totals), then min(SIZEOUT - OUT, MAX) bytes of stdout from
 * offset OUT and the same for stderr from ERR. The exit status is read
 * first, so once it shows, the sizes are final.
 */
export const POLL = `set -u
d=$1
[ -d "$d" ] || { echo missing; exit 0; }
x=-; [ -e "$d/exit" ] && x=$(cat "$d/exit")
tm=0; [ -e "$d/timedout" ] && tm=1
so=0; [ -e "$d/stdout" ] && so=$(wc -c < "$d/stdout")
se=0; [ -e "$d/stderr" ] && se=$(wc -c < "$d/stderr")
no=$((so - $2)); [ "$no" -gt "$4" ] && no=$4; [ "$no" -lt 0 ] && no=0
ne=$((se - $3)); [ "$ne" -gt "$4" ] && ne=$4; [ "$ne" -lt 0 ] && ne=0
printf '%s %s %s %s\\n' "$x" "$tm" "$((so + 0))" "$((se + 0))"
[ "$no" -gt 0 ] && tail -c +$(($2 + 1)) "$d/stdout" | head -c "$no"
[ "$ne" -gt 0 ] && tail -c +$(($3 + 1)) "$d/stderr" | head -c "$ne"
exit 0
`;

/** `KILL PID SIGNAL`: the process group first, then the process. */
export const KILL = `kill -s "$2" -- "-$1" 2> /dev/null || kill -s "$2" "$1"`;

/**
 * `SETUP USER DIR...`, as root: creates the directories and gives them to
 * USER ("-" for none). celld drops CAP_CHOWN, so when the image has not
 * already made a directory USER's, it becomes world-writable (sticky)
 * instead; images should provide the workspace owned by the user.
 */
export const SETUP = `set -u
u=$1
shift
for d; do
  [ -d "$d" ] || mkdir -p "$d" || exit 1
  [ "$u" = - ] && continue
  [ "$(stat -c %u:%g "$d")" = "$u" ] && continue
  chown "$u" "$d" 2> /dev/null || chmod 1777 "$d" || exit 1
done
`;

/** `MKDIRS DIR...`, as the sandbox user. */
export const MKDIRS = `mkdir -p "$@"`;
