# An extremely simple "commit cloud" backend for Jujutsu

## Usage
Run the server (from the root of this repository) using a recent version of
[Deno](https://deno.com):

```
cd $(jj root)
deno serve --port 1234 --unstable-kv src/qq/rpc-backend/server.ts
```

Install the `qq` binary, my fork based on the `jj_cli` crate (note: this binary
works fine with ordinary Git-based Jujutsu repositories too):

```
buck build --out $HOME/bin/qq depot//src/qq
```

Initialize a repository and author a few commits. You need to set
`QQ_RPC_BACKEND_URL` to the URL of the server you started.

```
export QQ_RPC_BACKEND_URL=http://localhost:1234
```

```
cd /tmp && mkdir qq-1 && cd qq-1

qq rpc init

echo hello > fst.txt
qq commit -m first
echo world > snd.txt
qq commit -m second
```

Now your `qq log` will look something vaguely like the following:

```
◉  ttznvloz <NO EMAIL> [1 minute ago] 93616f60
│  (empty) (no description set)
○  wwpwsxnv <NO EMAIL> [1 minute ago] 7d265bae git_head()
│  second
○  mmoywywz <NO EMAIL> [1 minute ago] e0bbebe7
│  first
◆  zzzzzzzz root() 00000000
```

Now, create another repository the same way in another directory:


```
cd /tmp && mkdir qq-2 && cd qq-2

qq rpc init
```

And running `qq log` will, with no explicit steps, automatically synchronize the
working copy with the state of the system in another directory, as well as all
history and operations:

```
Concurrent modification detected, resolving automatically.
Working copy  (@) now at: ttznvloz 93616f60 (empty) (no description set)
Parent commit (@-)      : wwpwsxnv 7d265bae second
Added 2 files, modified 0 files, removed 0 files
Updated working copy to fresh commit 93616f60caaa
◉  ttznvloz <NO EMAIL> [2 minutes ago] 93616f60
│  (empty) (no description set)
○  wwpwsxnv <NO EMAIL> [2 minutes ago] 7d265bae git_head()
│  second
○  mmoywywz <NO EMAIL> [2 minutes ago] e0bbebe7
│  first
◆  zzzzzzzz root() 00000000
```

You can see the log of operations as they were performed on the server by
viewing its console output.

## The basic idea

Jujutsu is a version control system structured as a Rust library. It has a
lot of internal Rust traits, which essentially handle all "stateful storage"
for a repository, as well as a few default implementations that implement this
"stateful storage" on top of the filesystem using Git. You can also create your
own custom Jujutsu binary with its own commands, and its own implementations of
said traits; these impls can store state differently, including in a centralized
manner (a la tools such as Perforce or Subversion).

A common legend referred to in the Jujutsu community is the so-called "commit
cloud": a version control system where commits are transparently synchronized
between machines using a centralized backend server, combined with some
extra magic to make such a design convenient and simple. This codebase
implements that idea, based on a simple principle which I alluded to during
[`$WORK`](https://ersc.io) one day in our internal chat:

> ... if you actually wanted to "prototype" a cloud backend... bolt a backend
onto JJ that translates every single method in a backend traits 1:1 to an HTTP
verb + json payload against some server ...

Thus, this "rpc" backend was born: every Jujutsu trait is simply implemented
as an HTTP method call to a remote server with a payload in the body. It
isn't robust or production ready, but might give you an idea of how this idea
operates.

## Various notes

- The reference client simply takes every `Commit` and `Tree` and serializes
  them into their protocol buffer form (just as they would be serialized on
  disk), and stores the resulting byte array in the server. It is not clever
  or smart, but will probably work okay even across versions.
- The reference server cannot handle files/blobs/objects larger than 64KiB —
  a limitation of Deno KV, which could be lifted by splitting the blob over
  multiple keys.
- This implementation uses a single global operations log shared by all
  clients. As an example consequence of this: the very first snapshot taken in
  a new directory (`qq-2`) will cause a op log merge to occur as a result of
  concurrency (as evident from trivially viewing the op log). This is because
  the op log from the server is not synchronized to `qq-2` on initialization;
  the first `qq log` command then causes a snapshot and, before committing,
  fetches the remote op log and merges them.
- This is not an endorsement or commitment to any kind of design in upstream
  Jujutsu for a Cloud Backend(TM), just an experiment to show people what the
  idea is about.

## Addendum: name inspiration

The [Yosys Open SYnthesis Suite](https://github.com/yosyshq/yosys) is a
toolchain for synthesizing (System)Verilog specifications; it features an
"rpc" function which, when configured properly, allows you to invokes a program
whenever it needs to find the source code to a module during compilation;
that program may then do anything it wishes before returning the results
over `stdout`. The name "rpc" alludes to the fact you are simply "calling" an
external program with a `stdin` and returning the results of `stdout` as if it were
a heavy-handed function call.

The name `rpc` here, then, simply alludes to the same idea: that the impls of
every internal Rust trait for Jujutsu simply translate to a 1:1 rpc call against
a server.
