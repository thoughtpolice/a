# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "installation test failed at line $LINENO ($case)" >&2' ERR
case=$1
root=$(cd -- "$2" && pwd -P)
export PATH="$root/bin" TMPDIR="$PWD" TZ=UTC0 LC_ALL=C.UTF-8
case $case in
versions)
 [[ $(gcc -dumpversion) == 10.5.0 ]]
 [[ $(g++ -dumpmachine) == x86_64-cellar-linux-musl ]]
 [[ $(bash --version) == *'version 5.2.15'* ]]
 [[ $(make --version) == *'GNU Make 4.2.1'* ]]
 [[ $(as --version) == *'2.30'* ]]
 [[ $(ld --version) == *'2.30'* ]]
 [[ $(bison --version) == *'3.4.1'* ]]
 [[ $(flex --version) == *'2.6.4'* ]]
 [[ $(groups --version) == *'6.10'* ]]
 [[ $(updatedb --version) == *'4.2.33'* ]]
 [[ $(sh -c 'printf shell') == shell ]]
 # Only the programs that read settings like BINDIR and M4 get them, so this
 # bash has none to pass on, and other programs keep the caller's values.
 [[ -z ${BINDIR+set}${LIBEXECDIR+set}${M4+set}${AWKPATH+set}${BISON_PKGDATADIR+set}${LOCATE_DB+set}${LOCATE_PATH+set} ]]
 [[ $(BINDIR=/caller M4=/caller printenv BINDIR M4) == $'/caller\n/caller' ]]
 for name in gcc g++ cpp gcov bash make as ld ar ranlib nm objcopy objdump strip readelf elfedit addr2line size strings c++filt gprof; do
  test -x "$root/bin/$name"
 done
 ;;
compilation)
 make --no-print-directory -j3 -f source/Makefile RANLIB=ranlib
 [[ $(cat recursive-passed) == jobserver ]]
 for p in native-c native-cxx; do
  readelf -l "$p" > headers
  readelf -d "$p" > dynamic
  grep LOAD headers
  if grep INTERP headers || grep NEEDED dynamic; then exit 1; fi
 done
 [[ $(ar t libhelper.a) == helper.o ]]
 nm libhelper.a | grep ' T add_many$'
 objdump -d native-c > disassembly
 grep '<main>:' disassembly
 objcopy --only-keep-debug native-c native.debug
 cp native-c stripped
 strip stripped
 [[ $(./stripped) == 'native C 4294967325' ]]
 cpp -P source/helper.c > preprocessed.c
 grep 'long add_many' preprocessed.c
 cat > modern.cc <<'SOURCE'
#include <filesystem>
#include <iostream>
#include <optional>
#include <string_view>
int main() {
  std::optional<std::string_view> name = "modern";
  std::filesystem::create_directories("modern-tree/nested");
  std::cout << *name << ' ' << std::filesystem::is_directory("modern-tree/nested") << '\n';
}
SOURCE
 g++ -std=gnu++17 -O2 -Werror modern.cc -o modern
 [[ $(./modern) == 'modern 1' ]]
 cat > gcov-interface.c <<'SOURCE'
#include <gcov.h>
int main(void) { __gcov_reset(); __gcov_dump(); return 0; }
SOURCE
 gcc -O2 -Werror gcov-interface.c -lgcov -o gcov-interface
 ./gcov-interface
 ;;
generators)
 bison --no-lines -d -o parser.cc source/cpp.y
 g++ -O2 -Werror -std=gnu++11 parser.cc -o parser
 ./parser '4294967296+7*3' 4294967317
 if ./parser '(4+)' 0; then exit 1; fi
 flex -L -+ -o scanner.cc source/cpp.l
 g++ -O2 -Werror scanner.cc -o scanner
 ./scanner
 yacc --no-lines -o calculator.c source/calculator.y
 gcc -O2 -Werror calculator.c -o calculator
 ./calculator '(4+7)*3' 33
 [[ $(printf "syscmd(\`printf native-m4')" | m4) == native-m4 ]]
 [[ $(gawk 'BEGIN {"printf native-awk" | getline x; print x; if (system("exit 0")) exit 1}') == native-awk ]]
 [[ $(printf 'input\n' | sed 'e printf native-sed') == $'native-sedinput' ]]
 ;;
files-and-archives)
 mkdir -p data/sub
 printf 'beta\nalpha\nbeta\n' > data/sub/text
 chmod 640 data/sub/text
 ln -s sub/text data/link
 cp -a data copy
 [[ $(stat -c %a copy/sub/text) == 640 ]]
 [[ $(readlink copy/link) == sub/text ]]
 [[ $(sort copy/sub/text | uniq -c | awk '{print $1 ":" $2}') == $'1:alpha\n2:beta' ]]
 [[ $(date -u -d '2000-02-28 12:00:00 UTC +1 day' '+%Y-%m-%d') == 2000-02-29 ]]
 printf 'one\ntwo\n' > before
 printf 'one\nthree\n' > after
 diff -u before after > change || test $? = 1
 patch before < change
 cmp before after
 for format in tar gz bz2; do
  tar --numeric-owner -cf archive.tar data
  case $format in
   gz) gzip -n -c archive.tar > archive.gz; gunzip -c archive.gz > roundtrip.tar;;
   bz2) bzip2 -c archive.tar > archive.bz2; bunzip2 -c archive.bz2 > roundtrip.tar;;
   tar) cp archive.tar roundtrip.tar;;
  esac
  cmp archive.tar roundtrip.tar
  mkdir "unpack-$format"
  (cd "unpack-$format"; tar --numeric-owner -xf ../roundtrip.tar)
  cmp data/sub/text "unpack-$format/data/sub/text"
 done
 tar --numeric-owner -czf compressed.tar.gz data
 mkdir unpack-compressed
 (cd unpack-compressed; tar --numeric-owner -xzf ../compressed.tar.gz)
 cmp data/sub/text unpack-compressed/data/sub/text
 [[ $(printf 'a\0b c\0' | xargs -0 -n1) == $'a\nb c' ]]
 [[ $(find data -name text -exec cat '{}' + | wc -l) == 3 ]]
 ;;
locate)
 mkdir -p data/sub
 printf a > data/alpha
 printf b > 'data/sub/beta words'
 export LOCALUSER='' NETPATHS='' PRUNEFS='' PRUNEPATHS='' PRUNEREGEX='^/nonexistent-bootstrap-prune$'
 updatedb --localpaths="$PWD/data" --output="$PWD/locate.db" --changecwd="$PWD"
 [[ $(locate -d locate.db -i ALPHA) == "$PWD/data/alpha" ]]
 [[ $(locate -d locate.db -r 'beta.*') == "$PWD/data/sub/beta words" ]]
 ;;
relocation)
 cp -a "$root" 'original installation'
 mv 'original installation' 'moved installation'
 moved="$PWD/moved installation"
 export PATH=/nonexistent-bootstrap-path
 [[ $("$moved/bin/gcc" -print-file-name=libc.a) == "$moved/lib/libc.a" ]]
 "$moved/bin/gcc" -O2 source/native.c source/helper.c -pthread -o relocated-c
 "$moved/bin/g++" -std=gnu++11 -pthread -O2 source/native.cc source/helper.c -o bad-language > language.out 2> language.err && exit 1
 "$moved/bin/gcc" -O2 -c source/helper.c -o helper.o
 "$moved/bin/g++" -std=gnu++11 -pthread -O2 source/native.cc helper.o -o relocated-cxx
 [[ $(./relocated-c) == 'native C 4294967325' ]]
 [[ $(./relocated-cxx) == 'native C++ 4294967299' ]]
 [[ $("$moved/bin/m4" --version) == *'1.4.7'* ]]
 "$moved/bin/make" --no-print-directory -j2 -f source/Makefile RANLIB=ranlib
 "$moved/bin/bison" --no-lines -o relocated-parser.c source/calculator.y
 "$moved/bin/gcc" relocated-parser.c -o relocated-parser
 ./relocated-parser '4+7*3' 25
 # Both database formats use the default database in the moved installation
 # and temporary files under a directory whose name contains a space.
 "$moved/bin/mkdir" -p located 'temporary files'
 printf a > located/alpha
 export LOCALUSER='' NETPATHS='' PRUNEFS='' PRUNEPATHS='' PRUNEREGEX='^/nonexistent-bootstrap-prune$'
 for format in '' --old-format; do
  TMPDIR="$PWD/temporary files" "$moved/bin/updatedb" $format --localpaths="$PWD/located" --changecwd="$PWD"
  [[ $("$moved/bin/locate" alpha) == "$PWD/located/alpha" ]]
  "$moved/bin/rm" "$moved/var/locatedb"
 done
 # A moved installation must fail rather than find a host header/library/helper.
 export PATH=/usr/bin:/bin
 "$moved/bin/rm" "$moved/include/stdio.h"
 if "$moved/bin/gcc" -c source/native.c -o missing.o > missing.out 2> missing.err; then exit 1; fi
 "$moved/bin/grep" 'stdio.h' missing.err
 "$moved/bin/cp" "$root/include/stdio.h" "$moved/include/stdio.h"
 "$moved/bin/rm" "$moved/lib/libc.a"
 if "$moved/bin/gcc" source/native.c helper.o -pthread -o missing > missing.out 2> missing.err; then exit 1; fi
 "$moved/bin/grep" 'cannot find -lc' missing.err
 "$moved/bin/cp" "$root/lib/libc.a" "$moved/lib/libc.a"
 "$moved/bin/rm" "$moved/libexec/gcc/x86_64-cellar-linux-musl/10.5.0/cc1"
 if "$moved/bin/gcc" -c source/native.c -o missing.o > missing.out 2> missing.err; then exit 1; fi
 "$moved/bin/grep" 'declared compiler tool not found: cc1' missing.err
 "$moved/bin/rm" "$moved/libexec/bootstrap/m4"
 if "$moved/bin/bison" -o missing-parser.c source/calculator.y > missing.out 2> missing.err; then exit 1; fi
 "$moved/bin/grep" 'm4' missing.err
 # The copy would otherwise stay in this action's cached output.
 "$root/bin/rm" -rf "$moved"
 ;;
*) exit 2;;
esac
printf 'passed\n' > passed
