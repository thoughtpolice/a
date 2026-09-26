# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
CFLAGS = -O2 -Wall -Wextra -Werror
CXXFLAGS = $(CFLAGS) -std=gnu++11 -pthread
.PHONY: all verify recursive child
all: verify recursive
helper.o: source/helper.c
	$(CC) $(CFLAGS) -c $< -o $@
libhelper.a: helper.o
	$(AR) crsD $@ $^
	$(RANLIB) -D $@
native-c: source/native.c libhelper.a
	$(CC) $(CFLAGS) -pthread $^ -o $@
native-cxx: source/native.cc libhelper.a
	$(CXX) $(CXXFLAGS) $^ -o $@
verify: native-c native-cxx
	test -n "$$BASH_VERSION"
	test "$$(./native-c)" = 'native C 4294967325'
	test "$$(./native-cxx)" = 'native C++ 4294967299'
recursive:
	+$(MAKE) --no-print-directory -f source/Makefile child
child:
	@test -n "$$BASH_VERSION"
	@printf 'jobserver\n' > recursive-passed
