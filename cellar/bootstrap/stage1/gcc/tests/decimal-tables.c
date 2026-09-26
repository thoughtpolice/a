/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdint.h>
#include <stdio.h>
#define DEC_BCD2DPD 1
#define DEC_BIN2DPD 1
#define DEC_BIN2CHAR 1
#define DEC_BIN2BCD8 1
#define DEC_DPD2BCD 1
#define DEC_DPD2BIN 1
#define DEC_DPD2BINK 1
#define DEC_DPD2BINM 1
#define DEC_DPD2BCD8 1
#include "decDPD.h"
#define PRINT(x) do { unsigned i; for (i=0; i<sizeof(x)/sizeof(x[0]); i++) printf("%lu\n",(unsigned long)x[i]); } while(0)
int main(void) {
    PRINT(BCD2DPD); PRINT(BIN2DPD); PRINT(BIN2CHAR); PRINT(BIN2BCD8);
    PRINT(DPD2BCD); PRINT(DPD2BIN); PRINT(DPD2BINK); PRINT(DPD2BINM);
    PRINT(DPD2BCD8);
    return ferror(stdout) ? 1 : 0;
}
