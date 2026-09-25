// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The POSIX shell scripts behind the file and process operations.
 *
 * Each is a constant: arguments reach it as positional parameters
 * (`sh -c SCRIPT celld-sandbox WORKSPACE ARGS...`), never by splicing text
 * into the script, so nothing a caller sends is parsed by a shell. They
 * run with busybox (the recommended images) and with dash and GNU
 * coreutils (the test fake), and use only `realpath`, `readlink`,
 * `dirname`, `basename`, `find`, `stat`, `wc`, `head`, `tail`, `mv -T`,
 * `mkfifo`, `setsid`, `grep`, `dmesg`, `/proc` and shell builtins.
 *
 * Paths are always absolute (the caller joins them to the workspace), and
 * a last name used on its own is written `./NAME`, so no argument can be
 * mistaken for an option.
 *
 * Exit statuses from 87 up are the scripts' own verdicts; `EXIT_CODES`
 * maps them to error codes.
 *
 * @module
 */

/** A script's own exit statuses and the error code each means. */
export const EXIT_CODES: Record<number, string> = {
  87: "is_symlink",
  88: "unsupported_image",
  89: "invalid",
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
//
// `guard` only refuses early: a path checked by name can change before it
// is used. What is used is pinned first. `enter D` changes into D
// (following links) and refuses unless the directory it landed in is
// inside; the shell's working directory then stays that directory, whatever
// happens to the path, and the scripts work on `./NAME` in it. `opened FD P`
// refuses unless the file open on FD (which is what gets read) is inside,
// by the kernel's own name for it. `made D` is `enter D` for a directory
// that may not exist yet: it enters D's deepest existing ancestor first and
// creates only the missing names below that pinned directory, so no check
// of D's name is ever followed by a use of that name.
//
// `pinned REL` is for calls that follow no link at all (`noFollow`): it
// enters the workspace and then each directory of the workspace-relative
// REL but the last name, which it leaves in $last (empty for the
// workspace itself), refusing a symbolic link on the way (87). Every step
// is checked by where it landed (`pwd -P` is the directory before it plus
// the name), so a link swapped in while it walks is caught too.
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
enter() {
  cd -P "$1" 2> /dev/null || { echo "not a directory: $1" >&2; exit 95; }
  here=$(pwd -P) || exit 1
  inside "$here" || { echo "the path leaves the workspace: $1" >&2; exit 92; }
}
opened() {
  r=$(readlink "/proc/self/fd/$1" 2> /dev/null) || { echo "cannot tell what was opened: $2" >&2; exit 91; }
  inside "$r" || { echo "the path leaves the workspace: $2" >&2; exit 92; }
}
made() {
  p=$1
  rest=
  while [ ! -e "$p" ] && [ ! -L "$p" ]; do
    rest="$(basename "$p")\${rest:+/\$rest}"
    p=$(dirname "$p")
  done
  enter "$p"
  [ -z "$rest" ] && return 0
  mkdir -p "./$rest" || exit 1
  enter "./$rest"
}
pinned() {
  cd -P "$w" || exit 90
  here=$w
  last=
  rest=$1
  while [ -n "$rest" ]; do
    c=\${rest%%/*}
    case "$rest" in */*) rest=\${rest#*/};; *) last=$c; return 0;; esac
    [ -L "./$c" ] && { echo "a symbolic link is on the path: $c" >&2; exit 87; }
    [ -e "./$c" ] || { echo "no such directory: $c" >&2; exit 93; }
    cd -P "./$c" 2> /dev/null || { echo "not a directory: $c" >&2; exit 95; }
    now=$(pwd -P) || exit 1
    [ "$now" = "$here/$c" ] || { echo "a symbolic link is on the path: $c" >&2; exit 87; }
    here=$now
  done
}
nolink() {
  [ -L "./$1" ] && { echo "a symbolic link: $1" >&2; exit 87; }
  return 0
}
landed() {
  r=$(readlink "/proc/self/fd/$1" 2> /dev/null) || { echo "cannot tell what was opened: $2" >&2; exit 91; }
  [ "$r" = "$2" ] || { echo "a symbolic link was followed: $2" >&2; exit 87; }
}
`;

/**
 * `READ PATH MAX [NOFOLLOW REL]`: the file's bytes on stdout, or 97 with its
 * size on stderr. The file is opened first and checked by what is open, so
 * a path swapped after the check cannot lead outside. The size check and
 * the read use that one descriptor, and the read is bounded: at most MAX +
 * 1 bytes, so a file that grew past MAX after the check shows as one byte
 * too many (the caller reports a cut) instead of an unbounded read. With
 * NOFOLLOW 1 the file is REL (workspace-relative), reached through
 * `pinned`, and neither it nor a directory on its way may be a symbolic
 * link (87): what is open must be exactly that name in that directory.
 */
export const READ = PRELUDE + `
if [ "\${3:-0}" = 1 ]; then
  pinned "$4"
  [ -n "$last" ] || { echo "is a directory: $1" >&2; exit 94; }
  nolink "$last"
  [ -e "./$last" ] || { echo "no such file: $1" >&2; exit 93; }
  [ -d "./$last" ] && { echo "is a directory: $1" >&2; exit 94; }
  [ -f "./$last" ] || { echo "not a regular file: $1" >&2; exit 98; }
  exec 3< "./$last" || { echo "no such file: $1" >&2; exit 93; }
  landed 3 "$here/$last"
else
  guard "$1"
  [ -e "$1" ] || { echo "no such file: $1" >&2; exit 93; }
  [ -d "$1" ] && { echo "is a directory: $1" >&2; exit 94; }
  [ -f "$1" ] || { echo "not a regular file: $1" >&2; exit 98; }
  exec 3< "$1" || { echo "no such file: $1" >&2; exit 93; }
  opened 3 "$1"
fi
[ -f /proc/self/fd/3 ] || { echo "not a regular file: $1" >&2; exit 98; }
s=$(stat -L -c %s /proc/self/fd/3) || exit 1
[ "$s" -gt "$2" ] && { echo "$s" >&2; exit 97; }
exec head -c $(($2 + 1)) <&3
`;

/**
 * `READSTREAM PATH MAX`: {@link READ} for streamed reads. The size of the
 * file that was opened goes to stderr as the first line, then at most that
 * many bytes of the same descriptor to stdout, so the size a caller
 * announces is the size of what it sends (a file that shrinks meanwhile
 * sends fewer).
 */
export const READSTREAM = READ.replace(
  "exec head -c $(($2 + 1)) <&3",
  'echo "$s" >&2\nexec head -c "$s" <&3',
);

/**
 * `WRITE PATH PARENTS MODE MAX`: stdin into PATH through a temporary file
 * and a rename, so readers never see half a file, then the number of bytes
 * written on stdout. PARENTS is 1 to create missing directories (below the
 * deepest existing one, pinned first; see `made`); MODE is octal or "-";
 * more than MAX bytes is 97. An existing symbolic link at PATH is
 * replaced, not followed; the temporary file is created new (noclobber),
 * never through a link.
 */
export const WRITE = PRELUDE + `
d=$(dirname "$1")
b=$(basename "$1")
guard "$d"
if [ "$2" = 1 ]; then made "$d"; else enter "$d"; fi
if [ -d "./$b" ] && [ ! -L "./$b" ]; then echo "is a directory: $1" >&2; exit 94; fi
t="./.celld-write-\${5:-$$}"
trap 'rm -f "$t"' EXIT
trap 'exit 143' TERM HUP INT
set -C
head -c $(($4 + 1)) > "$t" || exit 1
set +C
s=$(wc -c < "$t")
[ $((s + 0)) -gt "$4" ] && { echo "more than $4 bytes" >&2; exit 97; }
if [ "$3" != - ]; then chmod "$3" "$t" || exit 1; fi
mv -f -T "$t" "./$b" || exit 1
trap - EXIT
echo $((s + 0))
`;

/** Remove only the nonce-owned temporary write file after its process group has stopped. */
export const WRITEUNDO = PRELUDE + `
d=$(dirname "$1")
[ -d "$d" ] || exit 0
guard "$d"
enter "$d"
rm -f -- "./.celld-write-$2"
`;

/** `MKDIR PATH RECURSIVE`, from the deepest existing directory, pinned. */
export const MKDIR = PRELUDE + `
guard "$1"
if [ -e "$1" ] || [ -L "$1" ]; then
  if [ -d "$1" ] && [ "$2" = 1 ]; then exit 0; fi
  echo "already exists: $1" >&2; exit 96
fi
if [ "$2" = 1 ]; then
  p=$1
  rest=
  while [ ! -e "$p" ]; do
    rest="$(basename "$p")\${rest:+/\$rest}"
    p=$(dirname "$p")
  done
  enter "$p"
  mkdir -p "./$rest"
else
  [ -d "$(dirname "$1")" ] || { echo "no parent directory: $1" >&2; exit 95; }
  enter "$(dirname "$1")"
  mkdir "./$(basename "$1")"
fi
`;

/**
 * `REMOVE PATH MODE`: MODE `file` removes a file or link only; `empty`
 * also an empty directory; `tree` a directory and everything in it. Links
 * are removed, never followed.
 */
export const REMOVE = PRELUDE + `
d=$(dirname "$1")
b=$(basename "$1")
guard "$d"
[ -d "$d" ] || { echo "no such file: $1" >&2; exit 93; }
enter "$d"
if [ ! -e "./$b" ] && [ ! -L "./$b" ]; then echo "no such file: $1" >&2; exit 93; fi
if [ -d "./$b" ] && [ ! -L "./$b" ]; then
  case "$2" in
    file) echo "is a directory: $1" >&2; exit 94;;
    empty) rmdir "./$b" 2> /dev/null || { echo "the directory is not empty: $1" >&2; exit 99; };;
    *) rm -rf "./$b";;
  esac
else
  rm -f "./$b"
fi
`;

/**
 * `RENAME FROM TO`: refuses to replace a directory. Both directories are
 * pinned before anything moves: the target's is opened (descriptor 4,
 * checked by what is open) and the source's is entered, and the move names
 * the source relative to the working directory and the target through the
 * descriptor, so neither path is looked up again by name.
 */
export const RENAME = PRELUDE + `
sd=$(dirname "$1")
sb=$(basename "$1")
td=$(dirname "$2")
tb=$(basename "$2")
guard "$sd"
guard "$td"
[ -d "$td" ] || { echo "no parent directory: $2" >&2; exit 95; }
exec 4< "$td" || { echo "no parent directory: $2" >&2; exit 95; }
opened 4 "$2"
[ -d /proc/self/fd/4 ] || { echo "no parent directory: $2" >&2; exit 95; }
[ -d "$sd" ] || { echo "no such file: $1" >&2; exit 93; }
enter "$sd"
if [ ! -e "./$sb" ] && [ ! -L "./$sb" ]; then echo "no such file: $1" >&2; exit 93; fi
t="/proc/self/fd/4/$tb"
if [ -d "$t" ] && [ ! -L "$t" ]; then echo "the target is a directory: $2" >&2; exit 94; fi
mv -f -T "./$sb" "$t"
`;

/**
 * `STAT PATH [NOFOLLOW REL]`: `KIND LINK SIZE MTIME`, following links (LINK
 * is 1 for one). A file or directory is opened and checked by what is
 * open; anything else (a FIFO, a socket) is resolved, its directory
 * entered, and its entry there described without following it again. With
 * NOFOLLOW 1 the entry is REL, reached through `pinned`, and neither it nor
 * a directory on its way may be a symbolic link (87).
 */
export const STAT = PRELUDE + `
if [ "\${2:-0}" = 1 ]; then
  pinned "$3"
  n=\${last:-.}
  [ -n "$last" ] && nolink "$last"
  [ -e "./$n" ] || { echo "no such file: $1" >&2; exit 93; }
  if [ -d "./$n" ] || [ -f "./$n" ]; then
    exec 3< "./$n" || { echo "no such file: $1" >&2; exit 93; }
    if [ -n "$last" ]; then landed 3 "$here/$last"; else landed 3 "$here"; fi
    if [ -d /proc/self/fd/3 ]; then k=dir; else k=file; fi
    printf '%s 0 %s\\n' "$k" "$(stat -L -c '%s %Y' /proc/self/fd/3)"
  else
    printf 'other 0 %s\\n' "$(stat -c '%s %Y' "./$n")"
  fi
  exit 0
fi
guard "$1"
[ -e "$1" ] || { echo "no such file: $1" >&2; exit 93; }
l=0; [ -L "$1" ] && l=1
if [ -d "$1" ] || [ -f "$1" ]; then
  exec 3< "$1" || { echo "no such file: $1" >&2; exit 93; }
  opened 3 "$1"
  if [ -d /proc/self/fd/3 ]; then k=dir; else k=file; fi
  printf '%s %s %s\\n' "$k" "$l" "$(stat -L -c '%s %Y' /proc/self/fd/3)"
else
  r=$(realpath "$1" 2> /dev/null) || { echo "no such file: $1" >&2; exit 93; }
  enter "$(dirname "$r")"
  printf '%s %s %s\\n' other "$l" "$(stat -c '%s %Y' "./$(basename "$r")")"
fi
`;

/**
 * `LIST DIR RECURSIVE HIDDEN SKIP LINES [NOFOLLOW REL]`: one walk of DIR, in the order
 * `find` visits it, as lines. Each entry is its `./`-relative path, printed
 * once for a file, twice for a directory, three times for a symbolic link
 * and four times for anything else (busybox `find` has no `-printf`, so
 * the kind is the length of the run). NUL and newline are swapped (`tr`),
 * so a line is exactly one printed path and a newline inside a name comes
 * out as NUL. The first SKIP lines are dropped (a cursor) and at most
 * LINES are printed: `head` then exits, and the walk ends at its next
 * write (SIGPIPE), so the work is bounded by SKIP + LINES, not by the
 * tree. Hidden entries are pruned unless HIDDEN is 1. With NOFOLLOW 1 the
 * directory is REL, reached through `pinned`, and neither it nor a
 * directory on its way may be a symbolic link (87); the walk itself never
 * follows one.
 */
export const LIST = PRELUDE + `
if [ "\${6:-0}" = 1 ]; then
  pinned "$7"
  if [ -n "$last" ]; then
    nolink "$last"
    [ -e "./$last" ] || { echo "no such directory: $1" >&2; exit 93; }
    [ -d "./$last" ] || { echo "not a directory: $1" >&2; exit 95; }
    cd -P "./$last" || exit 1
    [ "$(pwd -P)" = "$here/$last" ] || { echo "a symbolic link was followed: $1" >&2; exit 87; }
  fi
else
  guard "$1"
  if [ ! -d "$1" ]; then
    [ -e "$1" ] && { echo "not a directory: $1" >&2; exit 95; }
    echo "no such directory: $1" >&2; exit 93
  fi
  enter "$1"
fi
depth=
[ "$2" = 1 ] || depth="-maxdepth 1"
skip=$4
lines=$5
if [ "$3" = 1 ]; then
  find . -mindepth 1 $depth \\( -type f -print0 -o -type d -print0 -print0 -o -type l -print0 -print0 -print0 -o -print0 -print0 -print0 -print0 \\)
else
  find . -mindepth 1 $depth -name '.*' -prune -o \\( -type f -print0 -o -type d -print0 -print0 -o -type l -print0 -print0 -print0 -o -print0 -print0 -print0 -print0 \\)
fi 2> /dev/null | tr '\\n\\000' '\\000\\n' | tail -n "+$((skip + 1))" | head -n "$lines"
exit 0
`;

/**
 * `GITCLONE TARGET URL DEPTH BRANCH LINKS CLAIM`: clones URL into TARGET, a
 * directory this script creates (an existing path, link or not, is 96). It
 * clones into its own working directory after entering the new directory,
 * so the path cannot be swapped under it, and removes the directory again
 * when the clone fails. Git reads no configuration but the new
 * repository's own (the caller sets `GIT_CONFIG_NOSYSTEM=1` and
 * `GIT_CONFIG_GLOBAL=/dev/null`) and runs with no hooks, credential
 * helpers, templates, redirects or transports but https.
 *
 * Unless LINKS is 1, symbolic links in the repository are checked out as
 * plain files holding the link's text (`core.symlinks=false`, for the
 * clone and in the new repository's configuration), so no path in the
 * checkout leads out of it.
 *
 * CLAIM is a file of the sandbox's state directory: once TARGET exists,
 * its device and inode go there, and the file is removed when the script
 * ends. A clone killed in between (its deadline, a cancellation) leaves
 * CLAIM behind, and {@link GITUNDO} removes the directory it names.
 */
export const GITCLONE = PRELUDE + `
d=$(dirname "$1")
b=$(basename "$1")
u=$2
n=$3
br=$4
ln=$5
claim=$6
guard "$d"
made "$d"
if [ -e "./$b" ] || [ -L "./$b" ]; then echo "already exists: $1" >&2; exit 96; fi
mkdir "./$b" 2> /dev/null || { echo "already exists: $1" >&2; exit 96; }
enter "./$b"
stat -c %d:%i . > "$claim" || { cd .. && rmdir "./$b"; exit 1; }
set -- -c protocol.allow=never -c protocol.https.allow=always \\
  -c core.hooksPath=/dev/null -c credential.helper= -c core.askPass= \\
  -c core.fsmonitor=false -c http.followRedirects=false \\
  -c submodule.recurse=false
[ "$ln" = 1 ] || set -- "$@" -c core.symlinks=false
set -- "$@" clone --template= --no-recurse-submodules --depth "$n"
[ "$ln" = 1 ] || set -- "$@" --config core.symlinks=false
[ -n "$br" ] && set -- "$@" --branch "$br"
git "$@" -- "$u" .
s=$?
[ "$s" = 0 ] || { cd .. && rm -rf "./$b"; }
rm -f "$claim"
exit "$s"
`;

/**
 * `GITUNDO TARGET CLAIM`: after a {@link GITCLONE} that was killed,
 * removes TARGET when it is still the directory CLAIM names (the same
 * device and inode), then CLAIM. Anything else at TARGET (another caller's
 * directory) is left alone.
 */
export const GITUNDO = PRELUDE + `
d=$(dirname "$1")
b=$(basename "$1")
c=$2
[ -s "$c" ] || { rm -f "$c"; exit 0; }
id=$(head -c 64 "$c")
guard "$d"
if [ -d "$d" ]; then
  enter "$d"
  if [ -d "./$b" ] && [ ! -L "./$b" ] && [ "$(stat -c %d:%i "./$b")" = "$id" ]; then
    rm -rf "./$b"
  fi
fi
rm -f "$c"
`;

/**
 * `SPAWN DIR MAX TIMEOUT CWD SHELL ARGV...` starts ARGV detached, in its
 * own session (`setsid`; without it the script refuses with 88), and
 * prints `PID PIDSTART SID SIDSTART`: the command's pid, the session its
 * supervisor stays in (this script's pid, for {@link SWEEP}), and the start
 * time of each (field 22 of `/proc/PID/stat`, 0 when it is gone already),
 * so a pid that is used again later is not mistaken for them.
 *
 * As in {@link RUN}, the command's first process (a SHELL script) writes
 * its own pid to DIR/pid and only then execs ARGV, so no command runs
 * without its pid on disk; when the pid cannot be written, ARGV never runs
 * (exit 125). Its stdout and stderr go through FIFOs into DIR/stdout and
 * DIR/stderr, each capped at MAX bytes rounded up to 512 (a file size limit
 * on the reader alone; the rest is read and dropped, so the process never
 * blocks on a full pipe). `cat` is the reader because it writes what it
 * reads at once, where GNU `head -c` would hold output back until its
 * buffer fills. When it ends, DIR/exit holds its status; TIMEOUT seconds
 * (0 for none) later it is killed and DIR/timedout exists.
 *
 * When the command has not started after about 10 s, or ended without its
 * pid, the supervisor is killed and the script exits 1; the caller then
 * runs {@link SPAWNUNDO}.
 */
export const SPAWN = `set -u
d=$1; b=$((($2 + 511) / 512)); t=$3; sh=$5
cd "$4" || { echo "cannot enter $4" >&2; exit 95; }
shift 5
command -v setsid > /dev/null 2>&1 || { echo "the image has no setsid: a process could not get its own process group" >&2; exit 88; }
mkdir -p "$d" && mkfifo "$d/o" "$d/e" || exit 1
r='echo $$ > "$0.tmp" && mv -f "$0.tmp" "$0" || exit 125; exec "$@"'
(
  ( trap '' XFSZ; ulimit -f "$b"; cat > "$d/stdout"; cat > /dev/null ) < "$d/o" &
  r1=$!
  ( trap '' XFSZ; ulimit -f "$b"; cat > "$d/stderr"; cat > /dev/null ) < "$d/e" &
  r2=$!
  setsid "$sh" -c "$r" "$d/pid" "$@" > "$d/o" 2> "$d/e" < /dev/null &
  c=$!
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
v=$!
n=0
while [ ! -e "$d/pid" ]; do
  n=$((n + 1))
  if [ -e "$d/exit" ] || [ "$n" -gt 1000 ]; then
    kill -s KILL "$v" 2> /dev/null
    echo "the process did not start" >&2
    exit 1
  fi
  sleep 0.01
done
started() { s=; read -r s < "/proc/$1/stat" 2> /dev/null; set -- \${s##*) }; echo "\${20:-0}"; }
p=$(head -c 16 "$d/pid")
echo "$p $(started "$p") $$ $(started $$)"
`;

/**
 * `SPAWNUNDO DIR`: after a {@link SPAWN} that failed, kills the process
 * group DIR/pid names (waiting up to about a second for it to appear)
 * unless DIR/exit shows it ended, opens and closes the output FIFOs so no
 * reader stays blocked on them, and removes DIR.
 */
export const SPAWNUNDO = `set -u
d=$1
[ -d "$d" ] || exit 0
n=0
while [ ! -s "$d/pid" ] && [ ! -e "$d/exit" ]; do
  n=$((n + 1))
  [ "$n" -gt 100 ] && break
  sleep 0.01
done
if [ -s "$d/pid" ] && [ ! -e "$d/exit" ]; then
  c=$(head -c 16 "$d/pid")
  case "$c" in
    ''|*[!0-9]*) ;;
    *) kill -s KILL -- "-$c" 2> /dev/null || kill -s KILL "$c" 2> /dev/null;;
  esac
fi
for f in "$d/o" "$d/e"; do
  if [ -p "$f" ]; then exec 3<> "$f"; exec 3>&-; fi
done
rm -rf -- "$d"
`;

/**
 * `POLL DIR OUT ERR MAX`: a header line `EXIT TIMEDOUT SIZEOUT SIZEERR`
 * (EXIT is `-` while running; the line is `missing` without DIR; the sizes
 * are the files' totals), then min(SIZEOUT - OUT, MAX) bytes of stdout from
 * offset OUT and the same for stderr from ERR. The exit status is read
 * first, so once it shows, the sizes are final.
 *
 * DIR and everything in it belong to the sandbox's user, the same user the
 * commands run as, so a command can rewrite them: the caller treats the
 * header as untrusted input and a malformed one as a lost process.
 */
export const POLL = `set -u
d=$1
[ -d "$d" ] || { echo missing; exit 0; }
x=-; [ -e "$d/exit" ] && x=$(head -c 16 "$d/exit")
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

/** The exit status of {@link RUN} when the command's group id could not be recorded. */
export const RUN_UNRECORDED = 125;

/** What {@link RUN} prints on stderr with {@link RUN_UNRECORDED}. */
export const RUN_UNRECORDED_MESSAGE =
  "celld-sandbox: the command's process group could not be recorded; it did not run";

/**
 * `RUN FILE STDIN SHELL ARGV...`: the wrapper of every foreground command.
 * ARGV runs in a new session and process group (`setsid`) under a small
 * SHELL script that first writes its own pid (the group's id) to FILE, and
 * only then execs ARGV: the id is on disk before anything of the command
 * runs, so {@link KILLRUN} can always find the group. If the id cannot be
 * written, or the image has no `setsid` (so there would be no group to
 * kill), ARGV never runs and the wrapper exits {@link RUN_UNRECORDED}. When ARGV exits, the whole group is killed before
 * this script exits with its status: nothing it started in its group
 * outlives it. STDIN is 1 to pass stdin on (an asynchronous command
 * otherwise reads /dev/null).
 */
export const RUN = `set -u
f=$1; i=$2; sh=$3
shift 3
rm -f "$f"
if [ "$i" = 1 ]; then exec 3<&0; else exec 3< /dev/null; fi
r='echo $$ > "$0.tmp" && mv -f "$0.tmp" "$0" || exit ${RUN_UNRECORDED}; exec "$@"'
if ! command -v setsid > /dev/null 2>&1; then
  echo "${RUN_UNRECORDED_MESSAGE}" >&2
  exit ${RUN_UNRECORDED}
fi
setsid "$sh" -c "$r" "$f" "$@" 0<&3 3<&- &
c=$!
exec 3<&-
wait "$c"
s=$?
p=
[ -s "$f" ] && read -r p < "$f"
case "$p" in ''|*[!0-9]*) p=$c;; esac
kill -s KILL -- "-$p" 2> /dev/null
if [ ! -s "$f" ]; then
  echo "${RUN_UNRECORDED_MESSAGE}" >&2
  exit ${RUN_UNRECORDED}
fi
rm -f "$f"
exit "$s"
`;

/**
 * `KILLRUN FILE`: kills the process group a {@link RUN} wrapper recorded,
 * and confirms it: it exits 0 only once no live process (zombies aside) is
 * left in the group, killing again meanwhile, and 1 when some process is
 * still there after about a second, so the caller contains the command
 * instead of reporting it stopped. The id is written just before the
 * command execs, so a kill that comes earlier waits for it (up to about a
 * second) instead of missing the group.
 */
export const KILLRUN = `n=0
while [ ! -s "$1" ]; do
  n=$((n + 1))
  [ "$n" -gt 100 ] && exit 0
  sleep 0.01
done
c=$(cat "$1") || exit 0
case "$c" in ''|*[!0-9]*) exit 0;; esac
members() {
  for p in /proc/[0-9]*; do
    s=
    read -r s < "$p/stat" 2> /dev/null || continue
    set -- \${s##*) }
    [ "$3" = "$c" ] || continue
    case "$1" in Z|X|x) ;; *) return 0;; esac
  done
  return 1
}
kill -s TERM -- "-$c" 2> /dev/null || kill -s TERM "$c" 2> /dev/null
sleep 0.05
kill -s KILL -- "-$c" 2> /dev/null || kill -s KILL "$c" 2> /dev/null
n=0
while members; do
  n=$((n + 1))
  [ "$n" -gt 100 ] && exit 1
  kill -s KILL -- "-$c" 2> /dev/null
  sleep 0.01
done
rm -f "$1"
exit 0
`;

/**
 * `SWEEP PROC SID:START...`: kills processes that left their command's
 * session. Only run inside a container (PROC is `/proc`), never on a host:
 * it reads the whole of PROC.
 *
 * A process may stay when its session is one of: PID 1's (the entrypoint);
 * a session whose leader is an engine exec (parent 0, pid not 1), which is
 * how every command and helper starts; a session whose leader is alive and
 * the child of such an exec (a foreground command under {@link RUN}); or
 * one of the SIDs given (running background processes and their
 * supervisors), while that SID's process is gone (its session's other
 * processes are the record's) or is still the process that was recorded:
 * its start time (field 22 of its `stat`) is START. A process that took a
 * recorded pid over after it ended does not match, so it cannot pass its
 * own session off as a recorded one. Anything else was made by a process
 * that called `setsid` (a daemon, a double fork) and is killed. Prints the
 * pid of each process it kills, and exits 1 when any of them is still
 * there.
 */
export const SWEEP = `set -u
P=$1
shift
allowed=" $* "
stat_of() { s=; read -r s < "$P/$1/stat" 2> /dev/null; [ -n "$s" ]; }
fields() { set -- \${s##*) }; st=$1; pp=$2; sid=$4; start=\${20:-}; }
engine() { [ "$1" != 1 ] && stat_of "$1" && fields && [ "$pp" = 0 ]; }
listed() {
  for a in $allowed; do
    case "$a" in
      "$1:"*)
        stat_of "$1" || return 0
        fields
        [ "$start" = "\${a#*:}" ] && return 0;;
    esac
  done
  return 1
}
kept() {
  [ "$1" = 1 ] && return 0
  [ "$1" = 0 ] && return 0
  listed "$1" && return 0
  stat_of "$1" || return 1
  fields
  [ "$pp" = 0 ] && [ "$1" != 1 ] && return 0
  engine "$pp"
}
sweep() {
  n=0
  for p in "$P"/[0-9]*; do
    pid=\${p#"$P"/}
    [ "$pid" = "$$" ] && continue
    stat_of "$pid" || continue
    fields
    [ "$st" = Z ] && continue
    [ "$pp" = 0 ] && continue
    kept "$sid" && continue
    echo "$pid"
    kill -s KILL "$pid" 2> /dev/null
    n=$((n + 1))
  done
}
sweep
[ "$n" = 0 ] && exit 0
sleep 0.1
sweep > /dev/null
[ "$n" = 0 ]
`;

/**
 * `RUNTIME`: prints `gvisor` when the container runs on gVisor, else
 * `other`. gVisor's kernel log starts with its own boot line,
 * `[   0.000000] Starting gVisor...`; the first line of the log must be
 * exactly that. The pinned BusyBox image installs `head` in `/bin`, not
 * `/usr/bin`; keep all probe tools absolute so guest PATH cannot spoof them.
 * A host kernel's log (readable under runc where
 * `kernel.dmesg_restrict` is 0) starts with the host's boot, and a message
 * that mentions gVisor anywhere else does not count.
 */
export const RUNTIME =
  `if /bin/dmesg 2> /dev/null | /bin/head -n 1 | /bin/grep -q -x -E '\\[ *[0-9]+\\.[0-9]+\\] Starting gVisor\\.\\.\\.'; then echo gvisor; else echo other; fi`;

/**
 * `REGEXCHECK PATTERN`: exit 0 or 1 when PATTERN is a POSIX extended
 * regular expression grep accepts, 2 when it is not. grep is given one
 * (empty) line to match: busybox compiles a pattern only when it has a
 * line, so an empty input such as `/dev/null` passes any pattern. The
 * line is a here-document, so grep is still `exec`ed and is the process
 * the caller's deadline kills: a pattern that is slow to compile costs the
 * container that time and never outlives the call.
 */
export const REGEXCHECK = `exec grep -E -e "$1" > /dev/null << 'EOF'

EOF
`;

/**
 * `LOGGREP PATTERN FILE...`: the first line of each FILE (`-` for stdin)
 * that matches PATTERN, a POSIX extended regular expression, in order, or
 * nothing. Missing files are skipped. The caller checks the pattern first
 * with {@link REGEXCHECK}; the search is `exec`ed, so grep is the very
 * process the caller's deadline kills and a pathological pattern costs the
 * container time, not the object, and never outlives the call. grep exits
 * 1 for no match and 2 when a file went away meanwhile; the caller accepts
 * both.
 */
export const LOGGREP = `set -u
p=$1
shift
a=
grep -a -e x /dev/null > /dev/null 2>&1
[ $? -le 1 ] && a=-a
n=$#
while [ "$n" -gt 0 ]; do
  f=$1
  shift
  n=$((n - 1))
  if [ "$f" = - ] || [ -e "$f" ]; then set -- "$@" "$f"; fi
done
[ $# -gt 0 ] || exit 0
exec grep $a -h -E -m 1 -e "$p" -- "$@"
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

/** `REMOVE_DIR DIR`: removes a process's state directory, if it is there. */
export const REMOVE_DIR = `rm -rf -- "$1"`;

/**
 * `MKDIRS DIR...`, as the sandbox user, once the image is known to have
 * `setsid` (88 otherwise): without it no command could get its own process
 * group, and a kill would reach its first process only.
 */
export const MKDIRS =
  `command -v setsid > /dev/null 2>&1 || { echo "the image has no setsid: commands could not get their own process groups" >&2; exit 88; }
mkdir -p "$@"`;

/**
 * `SEARCH DIR MODE HIDDEN CASE PATTERN [NOFOLLOW REL]`: the lines of the
 * regular files under DIR that match PATTERN (MODE `regex`: a POSIX
 * extended regular expression, else a fixed string; CASE 1 ignores case),
 * as `./PATH:LINE:TEXT`. DIR is entered and checked, then walked with
 * `find . -type f`: symbolic links are never followed, neither to a file
 * nor into a directory, and nothing is named on a command line that grep
 * could follow. With NOFOLLOW 1 the directory is REL, reached through
 * `pinned`, and neither it nor a directory on its way may be a symbolic
 * link (87). Hidden entries are pruned unless HIDDEN is 1. Binary files
 * are skipped where grep can tell them (`-I`).
 *
 * A regular expression is first compiled against one line, and one grep
 * cannot compile is 89 (`invalid`): the search's greps run with `-s`, so
 * their status 2 would otherwise read as "no matches", and busybox
 * compiles a pattern only when it has a line to match.
 */
export const SEARCH = PRELUDE + `
m=$2
h=$3
i=$4
q=$5
if [ "\${6:-0}" = 1 ]; then
  pinned "$7"
  if [ -n "$last" ]; then
    nolink "$last"
    [ -e "./$last" ] || { echo "no such directory: $1" >&2; exit 93; }
    [ -d "./$last" ] || { echo "not a directory: $1" >&2; exit 95; }
    cd -P "./$last" || exit 1
    [ "$(pwd -P)" = "$here/$last" ] || { echo "a symbolic link was followed: $1" >&2; exit 87; }
  fi
else
  guard "$1"
  if [ ! -d "$1" ]; then
    [ -e "$1" ] && { echo "not a directory: $1" >&2; exit 95; }
    echo "no such directory: $1" >&2; exit 93
  fi
  enter "$1"
fi
b=
grep -I -e x /dev/null > /dev/null 2>&1
[ $? -le 1 ] && b=-I
f=-F
[ "$m" = regex ] && f=-E
c=
[ "$i" = 1 ] && c=-i
if [ "$m" = regex ]; then
  grep -E -e "$q" > /dev/null 2>&1 << 'EOF'

EOF
  [ $? -eq 2 ] && { echo "pattern: not a valid POSIX extended regular expression" >&2; exit 89; }
fi
if [ "$h" = 1 ]; then
  exec find . -mindepth 1 -type f -exec grep $b $c -n -H -s $f -e "$q" -- {} +
fi
exec find . -mindepth 1 -name '.*' -prune -o -type f -exec grep $b $c -n -H -s $f -e "$q" -- {} +
`;
