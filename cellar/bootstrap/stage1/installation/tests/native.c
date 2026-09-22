/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <iconv.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <unwind.h>
#include <string.h>
extern long add_many(int, ...);
static int *parent_errno;
static void *thread(void *unused)
{
    (void)unused;
    if (&errno == parent_errno || errno) return (void *)1;
    errno = EDOM;
    return 0;
}
int main(void)
{
    pthread_t t;
    void *result;
    jmp_buf env;
    iconv_t cd;
    char input[] = "\xc3\xa9\xe7\x95\x8c", output[16], *in = input, *out = output;
    size_t inleft = 5, outleft = sizeof output;
    if (sizeof(_Unwind_Ptr) != sizeof(void *)) return 4;
    parent_errno = &errno; errno = EINVAL;
    if (pthread_create(&t, 0, thread, 0) || pthread_join(t, &result) || result || errno != EINVAL) return 1;
    if (add_many(8, 1L, 2L, 3L, 4L, 5L, 6L, 4294967296L, 8L) != 4294967325L) return 2;
    if (!setjmp(env)) longjmp(env, 0);
    cd = iconv_open("UTF-16LE", "UTF-8");
    if (cd == (iconv_t)-1 || iconv(cd, &in, &inleft, &out, &outleft) == (size_t)-1 ||
        inleft || (out-output) != 4 || memcmp(output, "\xe9\0\x4c\x75", 4) || iconv_close(cd)) return 3;
    puts("native C 4294967325");
    return 0;
}
