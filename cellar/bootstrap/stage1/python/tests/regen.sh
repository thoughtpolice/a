# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Regenerates CPython's generated sources in a copy of the source tree with
# the interpreter built from them, as make regen-all, clinic,
# regen-limited-abi and regen-stdlib-module-names would, and as make
# regen-unicodedata and the CJK mapping generators would with the data they
# download, then requires the copy to equal the original. The random Levenshtein examples are checked by
# tests/levenshtein.py instead, and the Big5-HKSCS table is not regenerated.
set -euo pipefail
trap 'echo "regeneration failed at line $LINENO" >&2' ERR
absolute() {
    printf '%s/%s\n' "$(cd "${1%/*}" && pwd)" "${1##*/}"
}
python=$(absolute "$1")
cp=$(absolute "$2")
chmod=$(absolute "$3")
rm=$(absolute "$4")
diff=$(absolute "$5")
source=$(cd "$6" && pwd)
levenshtein=$(absolute "$7")
unicode=$(cd "$8" && pwd)
cjk=$(cd "$9" && pwd)
setup_stdlib=$(absolute "${10}")
setup_bootstrap=$(absolute "${11}")
build=$(cd "${12}" && pwd)
"$cp" -R "$source" tree
"$chmod" -R u+w tree
cd tree
export PYTHONDONTWRITEBYTECODE=1
peg() {
    PYTHONPATH=Tools/peg_generator "$python" -m "$@"
}

# regen-cases
cases=Tools/cases_generator
"$python" $cases/opcode_id_generator.py -o Include/opcode_ids.h Python/bytecodes.c
"$python" $cases/target_generator.py -o Python/opcode_targets.h Python/bytecodes.c
"$python" $cases/uop_id_generator.py -o Include/internal/pycore_uop_ids.h Python/bytecodes.c
"$python" $cases/py_metadata_generator.py -o Lib/_opcode_metadata.py Python/bytecodes.c
"$python" $cases/tier1_generator.py -o Python/generated_cases.c.h Python/bytecodes.c
"$python" $cases/tier2_generator.py -o Python/executor_cases.c.h Python/bytecodes.c
"$python" $cases/optimizer_generator.py -o Python/optimizer_cases.c.h \
    Python/optimizer_bytecodes.c Python/bytecodes.c
"$python" $cases/opcode_metadata_generator.py -o Include/internal/pycore_opcode_metadata.h Python/bytecodes.c
"$python" $cases/uop_metadata_generator.py -o Include/internal/pycore_uop_metadata.h Python/bytecodes.c

# regen-typeslots
"$python" Objects/typeslots.py < Include/typeslots.h > Objects/typeslots.inc

# regen-token
"$python" Tools/build/generate_token.py rst Grammar/Tokens Doc/library/token-list.inc Doc/library/token.rst
"$python" Tools/build/generate_token.py h Grammar/Tokens Include/internal/pycore_token.h
"$python" Tools/build/generate_token.py c Grammar/Tokens Parser/token.c
"$python" Tools/build/generate_token.py py Grammar/Tokens Lib/token.py

# regen-ast
"$python" Parser/asdl_c.py Parser/Python.asdl -H Include/internal/pycore_ast.h \
    -I Include/internal/pycore_ast_state.h -C Python/Python-ast.c

# regen-keyword
peg pegen.keywordgen Grammar/python.gram Grammar/Tokens Lib/keyword.py

# regen-sre
"$python" Tools/build/generate_sre_constants.py Lib/re/_constants.py \
    Modules/_sre/sre_constants.h Modules/_sre/sre_targets.h

# regen-frozen: frozen.c and the lists in Makefile.pre.in and PCbuild.
"$python" Tools/build/freeze_modules.py --frozen-modules > /dev/null

# regen-pegen-metaparser and regen-pegen
peg pegen -q python Tools/peg_generator/pegen/metagrammar.gram -o Tools/peg_generator/pegen/grammar_parser.py
peg pegen -q c Grammar/python.gram Grammar/Tokens -o Parser/parser.c

# regen-test-frozenmain
"$python" Programs/freeze_test_frozenmain.py Programs/test_frozenmain.h > /dev/null

# regen-test-levenshtein draws its examples at random and keeps the shipped
# ones, so they are checked against the generator instead.
"$python" "$levenshtein" Tools/build/generate_levenshtein_examples.py Lib/test/levenshtein_examples.json

# regen-global-objects
"$python" Tools/build/generate_global_objects.py > /dev/null

# clinic
"$python" Tools/clinic/clinic.py --force --make --exclude Lib/test/clinic.test.c --srcdir . > /dev/null

# regen-limited-abi
"$python" Tools/build/stable_abi.py --generate-all Misc/stable_abi.toml > /dev/null

# regen-unicodedata reads the Unicode Character Database from where it would
# download it.
"$cp" -R "$unicode" Tools/unicode/data
"$python" Tools/unicode/makeunicodedata.py > /dev/null
"$rm" -rf Tools/unicode/data

# The CJK mapping generators read python-mappings and write their tables
# beside themselves, to be copied into Modules/cjkcodecs. The Big5-HKSCS
# table's source lies behind a click-through license, so genmap_tchinese.py
# makes only the Big5 and CP950 tables.
cd Tools/unicode
"$cp" "$cjk"/* python-mappings
"$python" genmap_schinese.py > /dev/null
"$python" genmap_korean.py > /dev/null
"$python" genmap_japanese.py > /dev/null
"$python" -c 'import genmap_tchinese; genmap_tchinese.main_tw()' > /dev/null
for path in "$cjk"/*; do
    "$rm" "python-mappings/${path##*/}"
done
for table in mappings_*.h; do
    "$cp" "$table" ../../Modules/cjkcodecs
    "$rm" "$table"
done
cd ../..

# regen-stdlib-module-names runs the interpreter from the build directory,
# where it takes the tree's Lib and the directory pybuilddir.txt names as its
# library, and lists the modules the configured Setup files and sysconfig
# name.
"$cp" "$python" python
"$cp" -R "$build" build
printf 'build/lib.linux-x86_64-3.14' > pybuilddir.txt
"$cp" "$setup_stdlib" Modules/Setup.stdlib
"$cp" "$setup_bootstrap" Modules/Setup.bootstrap
printf '# Edit this file for local setup changes\n' > Modules/Setup.local
./python Tools/build/generate_stdlib_module_names.py > Python/stdlib_module_names.h
"$rm" -rf python build pybuilddir.txt Modules/Setup.stdlib Modules/Setup.bootstrap Modules/Setup.local

cd ..
"$diff" -r "$source" tree
"$rm" -rf tree
printf 'regenerated\n' > result
