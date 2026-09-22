// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
static pid_t shell_pid, job_pid;
static int master;
static char output[65536];
static void fail(const char *what) {
  fprintf(stderr,"pty: %s: %s\n%s\n",what,strerror(errno),output);
  if(job_pid>0) kill(-job_pid,SIGKILL);
  if(shell_pid>0) {kill(-shell_pid,SIGKILL);kill(shell_pid,SIGKILL);waitpid(shell_pid,0,0);}
  exit(1);
}
static void send_text(const char *s) {
  size_t n=strlen(s); while(n) {ssize_t z=write(master,s,n);if(z<0){if(errno==EINTR)continue;fail("write");}s+=z;n-=z;}
}
static void receive(const char *marker) {
  size_t used=0; struct pollfd p={master,POLLIN,0};
  output[0]=0;
  while(!strstr(output,marker)) {
    ssize_t z; int r=poll(&p,1,8000);
    if(r<0&&errno==EINTR)continue;
    if(r<=0)fail("timeout");
    z=read(master,output+used,sizeof(output)-used-1);
    if(z<0&&errno==EINTR)continue;
    if(z<=0)fail("read");
    used+=z;output[used]=0;if(used+1==sizeof(output))fail("output overflow");
  }
}
static void step(const char *command,const char *expected) {
  send_text(command);receive("cellar> ");
  if(!strstr(output,expected))fail(expected);
}
/* Report only the continue from fg. After bg the job stays in the background,
   and its output could split the shell's next prompt. */
static void continued(int sig) {
  const char s[]="job-continued\n";(void)sig;
  if(tcgetpgrp(1)!=getpgrp())return;
  if(write(1,s,sizeof(s)-1)<0)_exit(1);
}
int main(int argc,char **argv) {
  char *slave,*helper,*bash,*inputrc,*jid;int st,fd;FILE *f;
  if(argc==2&&!strcmp(argv[1],"--job")) {
    signal(SIGINT,SIG_DFL);signal(SIGCONT,continued);
    if(write(1,"job-ready\n",10)!=10)_exit(1);
    for(;;)pause();
  }
  if(argc!=3)fail("arguments");
  helper=realpath(argv[0],0);bash=realpath(argv[1],0);inputrc=realpath(argv[2],0);
  if(!helper||!bash||!inputrc)fail("paths");
  master=posix_openpt(O_RDWR|O_NOCTTY);
  if(master<0||grantpt(master)||unlockpt(master))fail("pty allocation");
  slave=ptsname(master);if(!slave)fail("ptsname");
  shell_pid=fork();if(shell_pid<0)fail("fork");
  if(!shell_pid) {
    struct winsize size={24,100,0,0};
    if(setsid()<0)_exit(120);
    fd=open(slave,O_RDWR);if(fd<0||ioctl(fd,TIOCSCTTY,0)<0)_exit(121);
    ioctl(fd,TIOCSWINSZ,&size);
    if(dup2(fd,0)<0||dup2(fd,1)<0||dup2(fd,2)<0)_exit(122);
    if(fd>2)close(fd);close(master);
    clearenv();
    setenv("CELLAR_BOOTSTRAP_IDENTITY","1",1);
    setenv("PATH","/nonexistent-bootstrap-path",1);
    setenv("LC_ALL","C.UTF-8",1);setenv("TZ","UTC0",1);
    setenv("PS1","cellar> ",1);setenv("PS2","more> ",1);
    setenv("TERM","cellar-test",1);
    setenv("TERMCAP","cellar-test|bootstrap terminal:co#100:li#24:am:bs:cl=\\E[H\\E[2J:ce=\\E[K:cr=^M:up=\\E[A:nd=\\E[C:",1);
    setenv("INPUTRC",inputrc,1);setenv("HISTFILE","",1);
    setenv("CELLAR_PTY_HELPER",helper,1);
    execl(bash,bash,"--noprofile","--norc","-i",(char*)0);_exit(123);
  }
  receive("cellar> ");
  step("[[ $- == *m* ]] && printf 'jobs-enabled\\n'\n","\r\njobs-enabled\r\n");
  step("printf 'WRONG\\n'\001\013printf 'line-edit-pass\\n'\n","\r\nline-edit-pass\r\n");
  step("\020\n","\r\nline-edit-pass\r\n"); /* previous line via Readline */
  step("\"$CELLAR_PTY_HELPER\" --job & j=$!; printf 'JOB:%s\\n' \"$j\"\n","\r\nJOB:");
  jid=strstr(output,"\r\nJOB:");job_pid=(pid_t)strtol(jid+6,0,10);if(job_pid<=0)fail("job pid");
  /* The shell can print its prompt before the background exec completes.
     Wait for the child to install its handlers before sending job signals. */
  if(!strstr(output,"job-ready\r\n"))receive("job-ready\r\n");
  step("kill -STOP \"$j\"; wait \"$j\"; s=$?; ((s==147)) && printf 'STOPPED\\n'; jobs -s\n","\r\nSTOPPED\r\n");
  step("bg %+; kill -0 \"$j\" && printf 'RESUMED\\n'\n","\r\nRESUMED\r\n");
  step("kill -STOP \"$j\"; wait \"$j\"; printf 'READY\\n'\n","\r\nREADY\r\n");
  send_text("fg %+\n");receive("job-continued\r\n");
  if(tcgetpgrp(master)!=job_pid)fail("foreground process group");
  send_text("\003");receive("cellar> ");
  step("(( $? == 130 )) && printf 'INTERRUPTED\\n'\n","\r\nINTERRUPTED\r\n");
  job_pid=0;send_text("exit 0\n");
  if(waitpid(shell_pid,&st,0)!=shell_pid||!WIFEXITED(st)||WEXITSTATUS(st))fail("shell exit");
  shell_pid=0;close(master);free(helper);free(bash);free(inputrc);
  f=fopen("passed","w");if(!f)fail("result");fputs("passed\n",f);if(fclose(f))fail("result close");return 0;
}
