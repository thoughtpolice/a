/* Copyright (C) 2016 Jeremiah Orians
 * This file is part of M2-Planet.
 *
 * M2-Planet is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * M2-Planet is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with M2-Planet.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <stdarg.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>

/* Required constants */
/* For file I/O*/
#define EOF 0xFFFFFFFF
#define BUFSIZ 0x1000

/* For lseek */
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

/* Required variables */
FILE* stdin;
FILE* stdout;
FILE* stderr;
FILE* __list;

void __init_io()
{
	__list = NULL;
	stdin = calloc(1, sizeof(FILE));
	stdin->fd = STDIN_FILENO;
	stdin->bufmode = O_RDONLY;
	stdin->buflen = 1;
	stdin->buffer = calloc(2, sizeof(char));

	stdout = calloc(1, sizeof(FILE));
	stdout->fd = STDOUT_FILENO;
	stdout->bufmode = O_WRONLY;
	stdout->buflen = 512;
	stdout->buffer = calloc(514, sizeof(char));

	stderr = calloc(1, sizeof(FILE));
	stderr->fd = STDERR_FILENO;
	stderr->bufmode = O_WRONLY;
	stderr->buflen = 512;
	stderr->buffer = calloc(514, sizeof(char));
}


/* Flush all IO on exit */
int fflush(FILE* stream);
void __kill_io()
{
	fflush(stdout);
	fflush(stderr);
	while(NULL != __list)
	{
		fflush(__list);
		__list = __list->next;
	}
}

/* Standard C functions */
/* Getting */
int read(int fd, char* buf, unsigned count);
int fgetc(FILE* f)
{
	/* Only read on read buffers */
	if(O_WRONLY == f->bufmode) return EOF;

	/* Deal with stdin */
	if(STDIN_FILENO == f->fd)
	{
		f->bufpos = 0;
		int r = read(f->fd, f->buffer, 1);

		/* Catch special case of STDIN gets nothing (AN EOF) */
		if(0 == r) return EOF;
	}

	/* Catch EOF */
	if(f->buflen <= f->bufpos) return EOF;

	/* Deal with standard case */
	int ret = f->buffer[f->bufpos];
	f->bufpos = f->bufpos + 1;

	/* Ensure 0xFF doesn't return EOF */
	return (ret & 0xFF);
}

size_t fread( void* buffer, size_t size, size_t count, FILE* stream )
{
	if(0 == size) return 0;
	if(0 == count) return 0;

	long n = size + count - 1;
	char* p = buffer;
	long i;
	unsigned c;
	for(i = 0; i < n; i = i + 1)
	{
		c = fgetc(stream);
		if(EOF == c) return (i/size);
		p[i] = c;
	}

	return (i/size);
}

int getchar()
{
	return fgetc(stdin);
}


char* fgets(char* str, int count, FILE* stream)
{
	int i = 0;
	int ch;
	while(i < count)
	{
		ch = fgetc(stream);
		if(EOF == ch) {
			/* Return null if EOF is first char read */
			if (i == 0) return NULL;
			break;
		}

		str[i] = ch;
		i = i + 1;

		if('\n' == ch) break;
	}

	return str;
}

/* Putting */
void fputc(char s, FILE* f)
{
	/* Only write on write buffers */
	if(O_RDONLY == f->bufmode) return;

	/* Add to buffer */
	f->buffer[f->bufpos] = s;
	f->bufpos = f->bufpos + 1;

	/* Flush if full or '\n' */
	if(f->bufpos == f->buflen) fflush(f);
	else if(('\n' == s) && (2 >= f->fd)) fflush(f);
}

size_t fwrite(void const* buffer, size_t size, size_t count, FILE* stream )
{
	long n = size * count;
	if(0 == n) return 0;

	char* p = buffer;
	int c;
	long i;
	for(i=0; i < n; i = i + 1)
	{
		c = p[i];
		fputc(c, stream);
	}

	return (i/size);
}

void putchar(char s)
{
	fputc(s, stdout);
}


int fputs(char const* str, FILE* stream)
{
	while(0 != str[0])
	{
		fputc(str[0], stream);
		str = str + 1;
	}
	return 0;
}


int puts(char const* str)
{
	fputs(str, stdout);
	fputc('\n', stdout);
	return 0;
}


int lseek(int fd, int offset, int whence);
/* File management */
FILE* fopen(char const* filename, char const* mode)
{
	int f;
	FILE* fi = calloc(1, sizeof(FILE));
	fi->next = __list;
	if(NULL != __list) __list->prev = fi;
	__list = fi;
	int size;

	if('w' == mode[0]) f = open(filename, O_WRONLY|O_CREAT|O_TRUNC, 00600);
	else if('a' == mode[0]) f = open(filename, O_WRONLY|O_CREAT|O_APPEND, 00600);
	else f = open(filename, 0, 0); /* Everything else is a read */

	/* Negative numbers are error codes */
	if(0 > f)
	{
		return 0;
	}

	if('w' == mode[0] || 'a' == mode[0])
	{
		/* Buffer as much as possible */
		fi->buffer = malloc(BUFSIZ * sizeof(char));
		fi->buflen = BUFSIZ;
		fi->bufmode = O_WRONLY;
	}
	else
	{
		/* Get enough buffer to read it all */
		size = lseek(f, 0, SEEK_END);
		fi->buffer = malloc((size + 1) * sizeof(char));
		fi->buflen = size;
		fi->bufmode = O_RDONLY;

		/* Now read it all */
		lseek(f, 0, SEEK_SET);
		read(f, fi->buffer, size);
	}

	fi->fd = f;
	return fi;
}

FILE* fdopen(int fd, char* mode)
{
	FILE* fi = calloc(1, sizeof(FILE));
	fi->next = __list;
	if(NULL != __list) __list->prev = fi;
	__list = fi;
	int size;

	if('w' == mode[0])
	{
		/* Buffer as much as possible */
		fi->buffer = malloc(BUFSIZ * sizeof(char));
		fi->buflen = BUFSIZ;
		fi->bufmode = O_WRONLY;
	}
	else
	{
		/* Get enough buffer to read it all */
		size = lseek(fd, 0, SEEK_END);
		fi->buffer = malloc((size + 1) * sizeof(char));
		fi->buflen = size;
		fi->bufmode = O_RDONLY;

		/* Now read it all */
		lseek(fd, 0, SEEK_SET);
		read(fd, fi->buffer, size);
	}

	fi->fd = fd;
	return fi;
}


int write(int fd, char* buf, unsigned count);
int fflush(FILE* stream)
{
	/* We only need to flush on writes */
	if(O_RDONLY == stream->bufmode) return 0;

	/* If nothing to flush */
	if(0 ==stream->bufpos) return 0;

	/* The actual flushing */
	int error = write(stream->fd, stream->buffer, stream->bufpos);

	/* Keep track of position */
	stream->file_pos = stream->file_pos + stream->bufpos;
	stream->bufpos = 0;

	return error;
}


int close(int fd);
int fclose(FILE* stream)
{
	/* Deal with STDIN, STDOUT and STDERR */
	/* No close for you */
	if(2 >= stream->fd) return 0;

	/* We only need to flush on writes */
	if(O_WRONLY == stream->bufmode)
	{
		fflush(stream);
	}

	/* Need to keep the File Descriptor for a moment */
	int fd = stream->fd;

	/* Remove from __list */
	if(NULL != stream->prev) stream->prev->next = stream->next;
	if(NULL != stream->next) stream->next->prev = stream->prev;
	/* Deal with special case of first node in __list */
	if (__list == stream) __list = __list->next;

	/* Free up the buffer and struct used for FILE */
	free(stream->buffer);
	free(stream);

	/* Do the actual closing */
	return close(fd);
}


int unlink(char* filename);
/* File Removal */
int remove(char *pathname)
{
	return unlink(pathname);
}


/* File Positioning */
int ungetc(int ch, FILE* stream)
{
	/* Deal with STDIN, STDOUT and STDERR */
	/* No ungetc for you */
	if(2 >= stream->fd) return EOF;

	/* You can't unget on a write stream! */
	if(O_WRONLY == stream->bufmode) return EOF;

	/* Don't underflow */
	if(0 == stream->bufpos) return EOF;

	/* Don't let crap be shoved into read stream */
	if(stream->buffer[stream->bufpos - 1] != ch) return EOF;

	stream->bufpos = stream->bufpos - 1;

	return ch;
}


long ftell(FILE* stream)
{
	/* Deal with STDIN, STDOUT and STDERR */
	/* No ftell for you */
	if(2 >= stream->fd) return 0;

	/* Deal with buffered output */
	if(O_WRONLY == stream->bufmode) return stream->file_pos + stream->bufpos;

	/* Deal with read */
	return stream->bufpos;
}


int fseek(FILE* f, long offset, int whence)
{
	/* Deal with STDIN, STDOUT and STDERR */
	/* No seek and destroy missions */
	if(2 >= f->fd) return 0;

	/* Deal with ugly case */
	if(O_WRONLY == f->bufmode)
	{
		fflush(f);
		return lseek(f->fd, offset, whence);
	}

	/* Deal with read mode */
	int pos;

	if(SEEK_SET == whence)
	{
		pos = offset;
	}
	else if(SEEK_CUR == whence)
	{
		pos = f->bufpos + offset;
	}
	else if(SEEK_END == whence)
	{
		pos = f->buflen + offset;
	}
	else return -1;

	if(pos < 0) return -1;
	if(pos > f->buflen) return -1;

	f->bufpos = pos;
	return pos;
}


void rewind(FILE* f)
{
	fseek(f, 0, SEEK_SET);
}

char* __unsigned_integer_to_string(unsigned int value, int base, int uppercase)
{
	static char buf[60];

	char* digits = "0123456789abcdef";
	if(uppercase)
	{
		digits = "0123456789ABCDEF";
	}

	char* ptr = &buf + 59;
	*ptr = '\0';

	do
	{
		--ptr;
		*ptr = digits[value % base];
		value /= base;
	}
	while(value != 0);

	return ptr;
}

char* __integer_to_string(int value)
{
	static char buf[60];

	char* digits = "0123456789abcdef";

	char* ptr = &buf + 59;
	*ptr = '\0';

	do
	{
		--ptr;
		*ptr = digits[value % 10];
		value /= 10;
	}
	while(value != 0);

	return ptr;
}

int __vsnprintf_string_offset;
va_list __vsnprintf_ap;
/* One line since M2-Mesoplanet doesn't support multi line macros */
#define INLINE_STRSCPY str_i = 0; while(str[str_i] != '\0' && output < n) { s[output++] = str[str_i++]; }
int vsnprintf(char* s, size_t n, const char* format, va_list arg)
{
	int i = 0;
	int output = 0;
	int str_i;
	char* str;

	__vsnprintf_string_offset = 0;

	while(format[i] != '\0' && output < n)
	{
		if(format[i] == '%')
		{
			++i;

			if(format[i] == 's')
			{
				str = va_arg(arg, char*);
				INLINE_STRSCPY
			}
			else if(format[i] == 'u' || format[i] == 'x' || format[i] == 'X' || format[i] == 'o')
			{
				int uppercase = 0;
				int base = 10;
				if(format[i] == 'x')
				{
					base = 16;
				}
				else if(format[i] == 'X')
				{
					uppercase = 1;
					base = 16;
				}
				else if(format[i] == 'o')
				{
					base = 8;
				}

				unsigned int value = va_arg(arg, unsigned int);
				str = __unsigned_integer_to_string(value, base, uppercase);
				INLINE_STRSCPY
			}
			else if(format[i] == 'd' || format[i] == 'i')
			{
				int value = va_arg(arg, int);
				if(value < 0)
				{
					s[output++] = '-';
					value = -value;
				}
				str = __integer_to_string(value);
				INLINE_STRSCPY
			}
			else if(format[i] == 'c')
			{
				char value = va_arg(arg, char);
				s[output++] = value;
			}
			else if(format[i] == '%')
			{
					s[output++] = '%';
			}

			++i;
		}
		else
		{
			s[output++] = format[i++];
		}
	}

	__vsnprintf_string_offset = i;
	__vsnprintf_ap = arg;

	if(output < n)
	{
		/* Null terminator doesn't count */
		s[output] = '\0';
	}

	return output;
}
#undef INLINE_STRSCPY

#define PRINTF_BUFFER_SIZE 4096
/* Add one to always have a null terminator */
char printf_buf[PRINTF_BUFFER_SIZE + 1];
int vfprintf(FILE* stream, char* format, va_list arg)
{
	int output = 0;
	va_list ap = arg;

	do
	{
		output += vsnprintf(printf_buf, PRINTF_BUFFER_SIZE, format, ap);
		format += __vsnprintf_string_offset;
		ap = __vsnprintf_ap;
		fputs(printf_buf, stream);
	}
	while(__vsnprintf_string_offset != 0);

	return output;
}
#undef PRINTF_BUFFER_SIZE

int vsprintf(char* s, const char* format, va_list arg)
{
	/* M2-Planet doesn't handle large literals that well. */
	return vsnprintf(s, 2147483647, format, arg);
}

int sprintf(char* s, char* format, ...)
{
	va_list ap;
	va_start(ap, format);
	return vsprintf(s, format, ap);
}

int fprintf(FILE* stream, char* format, ...)
{
	va_list ap;
	va_start(ap, format);
	return vfprintf(stream, format, ap);
}

int printf(char* format, ...)
{
	va_list ap;
	va_start(ap, format);
	return vfprintf(stdout, format, ap);
}

int vprintf(const char * format, va_list arg)
{
	return vfprintf(stdout, format, arg);
}

int snprintf(char* s, size_t n, const char* format, ...)
{
	va_list ap;
	va_start(ap, format);
	return vsnprintf(s, n, format, ap);
}
