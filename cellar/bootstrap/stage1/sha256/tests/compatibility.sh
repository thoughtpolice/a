# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "sha256sum compatibility failed at line $LINENO" >&2' ERR
sha=$1
reference=$2
cmp=$3
rm=$4
shift 4

abc=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
empty=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
binary=37c24922b11acfb78e7e432b6c817eec55788f86a2e51efa82752f554bbf28e7

expect_failure() {
    local status=0
    "$@" > failed-out 2> failed-err || status=$?
    [[ $status == 1 ]]
}

compare_output() {
    # GNU help includes argv[0]; compare the same invocation name even though
    # Buck stores the executables in different artifact directories.
    (exec -a sha256sum "$sha" "$@") > actual
    (exec -a sha256sum "$reference" "$@") > expected
    "$cmp" actual expected
}

compare_stdin() {
    local input=$1
    shift
    "$sha" "$@" < "$input" > actual
    "$reference" "$@" < "$input" > expected
    "$cmp" actual expected
}

printf abc > abc
: > empty
printf 'a\0b\377c' > binary
[[ $("$sha" abc) == "$abc  abc" ]]
[[ $("$sha" empty) == "$empty  empty" ]]
[[ $("$sha" binary) == "$binary  binary" ]]
[[ $("$sha" < abc) == "$abc  -" ]]
[[ $("$sha" - < binary) == "$binary  -" ]]
[[ $("$sha" --binary abc) == "$abc *abc" ]]
[[ $("$sha" --text abc) == "$abc  abc" ]]
compare_output --version
[[ $(<actual) == 'sha256sum (GNU coreutils) 6.10'* ]]
compare_output --help
compare_output abc empty binary
compare_output -b abc empty binary
compare_output -t abc empty binary

# SHA256 padding crosses its block boundary at 56 bytes. These independent
# expected digests exercise both the one-block and two-block padding paths.
for vector in \
    55:9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318 \
    56:b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a \
    63:7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34 \
    64:ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb \
    65:635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0; do
    printf -v data '%*s' "${vector%%:*}" ''
    printf '%s' "${data// /a}" > boundary
    [[ $("$sha" boundary) == "${vector#*:}  boundary" ]]
done

# The standard million-'a' vector also exceeds the implementation's read
# buffer by several orders of magnitude. Generate it using shell builtins.
printf -v data '%1000s' ''
data=${data// /a}
for ((i=0; i<1000; i++)); do printf '%s' "$data"; done > million
[[ $("$sha" million) == 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0  million' ]]
compare_output million
compare_stdin million -

# GNU escaping must round-trip backslash/newline names, spaces and a filename
# beginning with '-'; text and binary checksum records are both accepted.
printf abc > 'space name'
printf abc > 'back\slash'
printf abc > $'line\nbreak'
printf abc > -dash
compare_output -- 'space name' 'back\slash' $'line\nbreak' -dash
[[ $("$sha" 'back\slash') == "\\$abc  back\\\\slash" ]]
[[ $("$sha" $'line\nbreak') == "\\$abc  line\\nbreak" ]]
"$sha" -- abc empty binary million 'space name' 'back\slash' $'line\nbreak' -dash > sums
"$reference" --check sums > reference-check
"$sha" --check sums > checked
"$cmp" checked reference-check
"$reference" -b -- abc empty binary million 'space name' 'back\slash' $'line\nbreak' -dash > sums
compare_output -c sums
compare_stdin sums --check -
"$sha" --check --status sums > status-out 2> status-err
[[ ! -s status-out && ! -s status-err ]]
printf '%s  abc\n' "${abc^^}" > uppercase
[[ $("$sha" -c uppercase) == 'abc: OK' ]]
printf '# comment\n%s  abc' "$abc" > unterminated
[[ $("$sha" -c unterminated) == 'abc: OK' ]]

# The GNU 6.10 interface predates --quiet, --strict and --zero. Validate its
# supported failure/status semantics rather than silently accepting errors.
printf '%s  abc\n' "$empty" > mismatch
expect_failure "$sha" --check mismatch
[[ $(<failed-out) == 'abc: FAILED' && -s failed-err ]]
expect_failure "$sha" --check --status mismatch
[[ ! -s failed-out && ! -s failed-err ]]
printf '%s  missing\n' "$abc" > missing-sum
expect_failure "$sha" --check missing-sum
[[ $(<failed-out) == 'missing: FAILED open or read' && -s failed-err ]]
printf 'malformed\n' > malformed
expect_failure "$sha" --check --warn malformed
[[ ! -s failed-out && $(<failed-err) == *'improperly formatted SHA256 checksum line'* ]]
printf 'malformed\n%s  abc\n' "$abc" > mixed
"$sha" --check --warn mixed > checked 2> warning
[[ $(<checked) == 'abc: OK' && $(<warning) == *'improperly formatted SHA256 checksum line'* ]]
expect_failure "$sha" --check empty
expect_failure "$sha" --check missing
expect_failure "$sha" --invalid-option
expect_failure "$sha" --status abc
expect_failure "$sha" missing abc
[[ $(<failed-out) == "$abc  abc" && -s failed-err ]]
expect_failure "$sha" .
[[ ! -s failed-out && -s failed-err ]]

# All three compiler generations must agree on real ELF binary inputs and
# successfully consume one another's GNU checksum records.
"$sha" "$@" > compiler-sums
"$reference" "$@" > reference-sums
"$cmp" compiler-sums reference-sums
for other in "$@"; do
    "$other" --check --status compiler-sums
done
# These names exercise GNU escaping on the Linux executor, but are not
# portable Buck output paths. Remove them only after every check completes.
"$rm" -- 'back\slash' $'line\nbreak'
printf 'passed\n' > passed
