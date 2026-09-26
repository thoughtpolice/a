# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: MIT
ifneq ($(notdir $(sort $(wildcard source/*.c))),helper.c main.c)
$(error GNU wildcard/sort expansion failed)
endif

.PHONY: all recurse verify
all: verify

%.o: source/%.c
	$(CC) $(CFLAGS) -c $< -o $@

libhelper.a: helper.o
	$(AR) crsD $@ $^

sample: main.o libhelper.a
	$(CC) $(CFLAGS) $^ -o $@

recurse:
	+$(MAKE) --no-print-directory -f source/child.mk child

verify: sample recurse
	+$(MAKE) --no-print-directory -q -f source/Makefile sample
	./sample > result.txt
	test "$$(<result.txt)" = 'native make 42'
	test "$$(<recursive.txt)" = 'recursive jobserver'
	printf 'passed\n' > passed
