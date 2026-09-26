/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#define CHECK(x) do { if(!(x)) { fprintf(stderr,"check failed at %d: %s\n",__LINE__,strerror(errno)); return 1; } } while(0)
static int create(const char *name) {
    FILE *f=fopen(name,"w"); return f && fputs("kept\n",f)>=0 && fclose(f)==0;
}
static int invoke(char *tool, char *option, char *path, const char *response) {
    int fd[2], status; pid_t pid;
    if(pipe(fd)) return -1;
    pid=fork(); if(pid<0) return -1;
    if(!pid) {
        char *args[]={tool,option,"--",path,NULL};
        close(fd[1]); if(dup2(fd[0],0)<0) _exit(126); close(fd[0]);
        execv(tool,args); _exit(127);
    }
    close(fd[0]);
    if(response && write(fd[1],response,strlen(response))!=strlen(response)) return -1;
    close(fd[1]);
    if(waitpid(pid,&status,0)!=pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}
int main(int argc,char **argv) {
    char name[64]; unsigned i; struct stat st; FILE *f;
    CHECK(argc==2);
    CHECK(invoke(argv[1],"-f","missing",NULL)==0);
    CHECK(invoke(argv[1],"-v","missing",NULL)==1);
    CHECK(create("plain") && invoke(argv[1],"-v","plain",NULL)==0 && access("plain",F_OK)<0);
    CHECK(create("-leading") && invoke(argv[1],"-f","-leading",NULL)==0);
    CHECK(create("prompt") && invoke(argv[1],"-i","prompt","n\n")==0 && access("prompt",F_OK)==0);
    CHECK(invoke(argv[1],"-i","prompt","y\n")==0 && access("prompt",F_OK)<0);
    CHECK(mkdir("tree",0700)==0 && mkdir("tree/child",0700)==0 && mkdir("outside",0700)==0);
    CHECK(create("outside/kept") && symlink("../outside","tree/link")==0 && symlink("absent","tree/dangling")==0);
    for(i=0;i<40;i++) { snprintf(name,sizeof(name),"tree/child/file%u",i); CHECK(create(name)); }
    CHECK(invoke(argv[1],"-f","tree",NULL)==1 && stat("tree",&st)==0);
    CHECK(invoke(argv[1],"-rf","tree",NULL)==0 && access("tree",F_OK)<0 && access("outside/kept",F_OK)==0);
    CHECK(invoke(argv[1],"-rf",".",NULL)==1 && access("outside/kept",F_OK)==0);
    CHECK(invoke(argv[1],"-rf","outside",NULL)==0);
    f=fopen("passed","w"); CHECK(f && fputs("passed\n",f)>=0 && fclose(f)==0);
    return 0;
}
