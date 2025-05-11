#!/usr/bin/env sh

# the m2_mesoplanet compiler has a hardcoded limit of 4096 bytes for any entry
# in **envp. If a user is running on a machine where any of their ambient
# environment variables are longer than this, the compiler will panic. this
# script purifies the environment by removing all variables except PATH and
# M2LIBC_PATH

OUR_PATH=$OUR_PATH
OUR_M2LIBC_PATH=$OUR_M2LIBC_PATH
M2_MESOPLANET="$1"

/usr/bin/env -i -- \
  PATH="$OUR_PATH" \
  M2LIBC_PATH="$OUR_M2LIBC_PATH" \
  "$M2_MESOPLANET" \
  "${@:2}"
