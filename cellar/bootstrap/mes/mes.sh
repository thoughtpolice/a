#!/bin/sh

export MES_PREFIX="$1"
export GUILE_LOAD_PATH="$1/mes/module:$1/module"
shift

PROGRAM="$1"; shift
exec "$PROGRAM" "$@"
