/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "bconfig.h"
#include "system.h"
#include "coretypes.h"
#include "tm.h"
#include "rtl.h"
#include "genrtl.h"
#include "insn-config.h"
#include "insn-codes.h"
#include "insn-constants.h"
#include "gensupport.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"RTL check failed at %d\n",__LINE__); return 1; } } while (0)

int main(int argc, char **argv)
{
    rtx reg, value, sum, copy;
    FILE *f; char line[2048];
    unsigned yes = 0, no = 0, deferred = 0;
    CHECK(argc == 2);
    f = fopen(argv[1], "r"); CHECK(f);
    while (fgets(line, sizeof(line), f)) {
        if (!strncmp(line, "  (1 ", 5)) ++yes;
        if (!strncmp(line, "  (0 ", 5)) ++no;
        if (!strncmp(line, "  (-1 ", 6)) ++deferred;
    }
    CHECK(!ferror(f) && fclose(f) == 0);
    CHECK(yes > 0 && no > 0 && deferred > 1000);
    CHECK(sizeof(HOST_WIDE_INT) == 8);
    CHECK(GET_MODE_CLASS(DImode) == MODE_INT);
    CHECK(GET_MODE_CLASS(XFmode) == MODE_FLOAT);
    CHECK(GET_MODE_CLASS(V2DFmode) == MODE_VECTOR_FLOAT);
    CHECK(!strcmp(GET_MODE_NAME(DImode), "DI"));
    CHECK(!strcmp(GET_MODE_NAME(XFmode), "XF"));
    CHECK(CODE_FOR_adddi3 < CODE_FOR_nothing && CODE_FOR_movdi < CODE_FOR_nothing);
    CHECK(MAX_RECOG_OPERANDS >= 10 && MAX_INSNS_PER_SPLIT >= 3);
    CHECK(SP_REG == 7 && BP_REG == 6);

    reg = gen_rtx_raw_REG(DImode, 5);
    value = gen_rtx_raw_CONST_INT(VOIDmode, 0x123456789abcdefL);
    sum = gen_rtx_PLUS(DImode, reg, value);
    CHECK(REGNO(reg) == 5 && GET_MODE(reg) == DImode);
    CHECK(INTVAL(value) == 0x123456789abcdefL);
    CHECK(GET_CODE(sum) == PLUS && XEXP(sum, 0) == reg && XEXP(sum, 1) == value);
    copy = copy_rtx(sum);
    CHECK(copy != sum && XEXP(copy, 0) == reg && XEXP(copy, 1) == value);
    return 0;
}
