# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Runs CPython's regression tests in the working directory, from a writable
# copy of the installation with the source tree's Lib/test added to its
# library, where tests that start isolated interpreters find it. The
# interpreter runs by its absolute path, as if installed there. The isolated
# interpreters ignore PYTHONDONTWRITEBYTECODE, and test_zipfile compiles
# modules with py_compile, so bytecode lands in the copy rather than in the
# installation's artifact.
#
# As in make test, regrtest runs the test files in parallel worker
# processes. -j0 would size the pool by the CPUs a machine reports, which on
# a remote executor need not be the CPUs the action may use, so the pool is
# fixed at four.
#
# Usage: regrtest.sh CP CHMOD RM INSTALLATION LIBDEST TESTS REGRTEST-ARGS...
# LIBDEST is the standard library's directory within INSTALLATION.
set -euo pipefail
cp=$1
chmod=$2
rm=$3
installation=$4
libdest=$5
tests=$6
shift 6
export HOME="$PWD" TMPDIR="$PWD" PYTHONDONTWRITEBYTECODE=1
"$cp" -R "$installation" installation
"$chmod" -R u+w installation
"$cp" -R "$tests" "installation/$libdest/test"
"$chmod" -R u+w "installation/$libdest/test"
"$PWD/installation/bin/python3" -m test --quiet --fail-env-changed -j4 "$@"
"$rm" -rf installation
printf 'passed\n' > result
