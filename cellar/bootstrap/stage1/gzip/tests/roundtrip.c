// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <utime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *gzip_bin;
static void check(int ok, const char *what) { if (!ok) { perror(what); exit(1); } }
static int run(const char *out, char *a, char *b, char *c) {
  int st; pid_t p=fork(); check(p>=0,"fork");
  if (!p) {
    if(out) { int fd=open(out,O_CREAT|O_TRUNC|O_WRONLY,0600); if(fd<0||dup2(fd,1)<0) _exit(125); close(fd); }
    execl(gzip_bin,gzip_bin,a,b,c,(char*)0); _exit(126);
  }
  check(waitpid(p,&st,0)==p && WIFEXITED(st),"wait"); return WEXITSTATUS(st);
}
static void same(const char *a,const char *b) {
  FILE *x=fopen(a,"rb"),*y=fopen(b,"rb"); int c,d; check(x&&y,"compare open");
  do {c=fgetc(x);d=fgetc(y);check(c==d,"round trip");} while(c!=EOF);
  check(!ferror(x)&&!ferror(y),"compare read"); fclose(x); fclose(y);
}
int main(int argc,char **argv) {
  FILE *f; struct stat st; struct utimbuf times={946684800,946684800}; unsigned v=1; int i,c;
  check(argc==2,"arguments"); gzip_bin=argv[1];
  f=fopen("original","wb");check(f!=0,"create");
  for(i=0;i<200000;i++){v=v*1664525u+1013904223u; fputc(i%3 ? i%251 : (int)(v>>24),f);}
  check(fclose(f)==0,"close");
  check(run("data.gz","-9nc","original",0)==0,"compress");
  check(run("again.gz","-9nc","original",0)==0,"repeat compress");same("data.gz","again.gz");
  check(run(0,"-t","data.gz",0)==0,"integrity");
  check(run("restored","-dc","data.gz",0)==0,"decompress");same("original","restored");
  check(utime("restored",&times)==0 && chmod("restored",0640)==0,"metadata");
  check(run(0,"restored",0,0)==0,"in-place compression");
  check(access("restored",F_OK)<0,"input removal");
  check(run(0,"-d","restored.gz",0)==0,"in-place decompression");same("original","restored");
  check(stat("restored",&st)==0 && st.st_mtime==times.modtime && (st.st_mode&0777)==0640,"metadata preservation");
  f=fopen("data.gz","r+b");check(f!=0,"damage open");check(fseek(f,-8,SEEK_END)==0,"damage seek");c=fgetc(f);check(c!=EOF,"crc byte");check(fseek(f,-1,SEEK_CUR)==0,"crc seek");fputc(c^1,f);check(fclose(f)==0,"damage close");
  check(run(0,"-t","data.gz",0)==1,"reject bad CRC");
  f=fopen("passed","w");check(f!=0,"passed");fputs("passed\n",f);check(fclose(f)==0,"passed close");return 0;
}
