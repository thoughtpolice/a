# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Regenerates CPython's generated sources in a copy of the source tree with
# the interpreter built from them, as make regen-all, clinic and
# regen-limited-abi would, then requires the copy to equal the original. The
# random Levenshtein examples are checked by tests/levenshtein.py instead. The
# Unicode database, the CJK mapping tables and stdlib_module_names.h are not
# regenerated: the first two need the Unicode consortium's data files, the
# last a build directory.
set -euo pipefail
trap 'echo "regeneration failed at line $LINENO" >&2' ERR
absolute() {
    printf '%s/%s\n' "$(cd "${1%/*}" && pwd)" "${1##*/}"
}
python=$(absolute "$1")
cp=$2
chmod=$3
rm=$4
diff=$(absolute "$5")
source=$(cd "$6" && pwd)
levenshtein=$(absolute "$7")
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

cd ..
"$diff" -r "$source" tree
"$rm" -rf tree
printf 'regenerated\n' > result
