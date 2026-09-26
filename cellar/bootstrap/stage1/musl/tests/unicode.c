/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <errno.h>
#include <iconv.h>
#include <locale.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

static int conversion(const char *encoding, const char *encoded, size_t size,
                      const char *utf8, size_t utf8_size, int reverse)
{
    iconv_t cd;
    char buffer[80], *input, *output;
    size_t left, room;
    int direction;
    for (direction = 0; direction <= reverse; direction++) {
        cd = iconv_open(direction ? encoding : "UTF-8", direction ? "UTF-8" : encoding);
        if (cd == (iconv_t)-1) return 1;
        input = (char *)(direction ? utf8 : encoded);
        left = direction ? utf8_size : size;
        output = buffer;
        room = sizeof buffer;
        if (iconv(cd, &input, &left, &output, &room) != 0 || left) return 2;
        if ((size_t)(output-buffer) != (direction ? size : utf8_size)) return 3;
        if (memcmp(buffer, direction ? encoded : utf8, output-buffer)) return 4;
        if (iconv_close(cd)) return 5;
    }
    return 0;
}

int main(void)
{
    iconv_t cd;
    char buffer[8], *in, *out;
    size_t left, room;
    wchar_t wc;
    mbstate_t state = {0};
    if (!setlocale(LC_ALL, "C.UTF-8")) return 1;
    if (!iswalpha(0x03a9) || !iswalpha(0x4e2d) || iswalpha(L'7')) return 2;
    if (!iswalnum(L'7') || !iswpunct(L'!') || iswpunct(L' ')) return 3;
    if (towlower(0x03a9) != 0x03c9 || towupper(0x00e9) != 0x00c9) return 4;
    if (!iswupper(0x03a9) || !iswlower(0x03c9)) return 5;
    if (towctrans(0x03a9, wctrans("tolower")) != 0x03c9) return 6;
    if (!iswctype(0x4e2d, wctype("alpha"))) return 7;
    if (wcwidth(0x0301) != 0 || wcwidth(0x4e2d) != 2 || wcwidth(L'A') != 1) return 8;
    if (wcswidth(L"A\u4e2d\u0301", 3) != 3) return 9;
    if (mbrtowc(&wc, "\xe4\xb8\xad", 3, &state) != 3 || wc != 0x4e2d) return 10;
    if (conversion("UTF-16LE", "\x2d\x4e\x3d\xd8\x00\xde", 6,
                   "\xe4\xb8\xad\xf0\x9f\x98\x80", 7, 1)) return 11;
    if (conversion("CP1252", "\x80\xe9", 2, "\xe2\x82\xac\xc3\xa9", 5, 1)) return 12;
    if (conversion("SHIFT_JIS", "\x93\xfa", 2, "\xe6\x97\xa5", 3, 1)) return 13;
    if (conversion("BIG5", "\xa4\xa4", 2, "\xe4\xb8\xad", 3, 0)) return 14;
    if (conversion("EUC-KR", "\xb0\xa1", 2, "\xea\xb0\x80", 3, 0)) return 15;
    if (conversion("GB18030", "\xd6\xd0", 2, "\xe4\xb8\xad", 3, 0)) return 16;
    cd = iconv_open("UTF-16LE", "UTF-8");
    if (cd == (iconv_t)-1) return 17;
    in = "\xff"; left = 1; out = buffer; room = sizeof buffer; errno = 0;
    if (iconv(cd, &in, &left, &out, &room) != (size_t)-1 || errno != EILSEQ || left != 1) return 18;
    in = "\xe4\xb8"; left = 2; errno = 0;
    if (iconv(cd, &in, &left, &out, &room) != (size_t)-1 || errno != EINVAL || left != 2) return 19;
    in = "A"; left = 1; room = 1; errno = 0;
    if (iconv(cd, &in, &left, &out, &room) != (size_t)-1 || errno != E2BIG || left != 1) return 20;
    if (iconv_close(cd)) return 21;
    puts("Unicode classification, case, width, multibyte and iconv pass");
    return 0;
}
