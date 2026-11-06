// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command smoke-test drives clangd over LSP, through the launcher, on the
// fixtures under tests/.
//
// It checks that Helix, Claude Code and OMP start clangd alike, then has the
// launcher write the compilation database and checks the entry
// of tests/hello/main.cpp, whose include path should name the repository's
// directories rather than Buck's header trees. Then it starts clangd with
// that command, opens main.cpp, waits for it to compile without errors, and
// looks up the definitions of a function from the library's header, a
// macro from its generated header, and std::vector. Buck runs in the shared
// daemon that runs this test, and clangd's database and index go in a
// temporary cache directory.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	timeout = 10 * time.Minute
	tests   = "buck/toolchains/cxx/lsp/tests"
)

var (
	deadline = time.Now().Add(timeout)
	root     string
	cache    string
)

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", args...)
	cleanup()
	os.Exit(1)
}

func cleanup() {
	if running != nil {
		running.stop()
	}
	if cache != "" {
		os.RemoveAll(cache)
	}
}

func main() {
	var err error
	if cache, err = os.MkdirTemp("", "clangd-smoke-"); err != nil {
		fail("%v", err)
	}
	os.Setenv("XDG_CACHE_HOME", cache)
	out, err := exec.Command("buck2", "root", "--kind", "project").Output()
	if err != nil {
		fail("buck2 root: %v", err)
	}
	root = strings.TrimSpace(string(out))

	command := configured()
	database()
	lsp(command)
	cleanup()
	fmt.Println("PASS")
}

func readJSON(path string) map[string]any {
	data, err := os.ReadFile(filepath.Join(root, path))
	if err != nil {
		fail("%v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		fail("%s: %v", path, err)
	}
	return v
}

// readHelix reads [language-server.clangd] from .helix/languages.toml, whose
// right-hand sides there are JSON as well as TOML.
func readHelix() []string {
	f, err := os.Open(filepath.Join(root, ".helix/languages.toml"))
	if err != nil {
		fail("%v", err)
	}
	defer f.Close()
	var command string
	var args []string
	in := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			in = line == "[language-server.clangd]"
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !in || !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "command":
			json.Unmarshal([]byte(strings.TrimSpace(value)), &command)
		case "args":
			json.Unmarshal([]byte(strings.TrimSpace(value)), &args)
		}
	}
	if err := scanner.Err(); err != nil {
		fail(".helix/languages.toml: %v", err)
	}
	if command == "" {
		fail(".helix/languages.toml has no [language-server.clangd] command")
	}
	return append([]string{command}, args...)
}

func commandOf(server map[string]any) []string {
	cmd := []string{server["command"].(string)}
	for _, a := range server["args"].([]any) {
		cmd = append(cmd, a.(string))
	}
	return cmd
}

func configured() []string {
	helix := readHelix()
	for path, server := range map[string]any{
		".claude/marketplace/lsp/.lsp.json": readJSON(".claude/marketplace/lsp/.lsp.json")["clangd"],
		".omp/lsp.json":                     readJSON(".omp/lsp.json")["servers"].(map[string]any)["clangd"],
	} {
		s, ok := server.(map[string]any)
		if !ok {
			fail("%s configures no clangd", path)
		}
		if got := commandOf(s); !reflect.DeepEqual(got, helix) {
			fail("%s starts clangd as %q, .helix/languages.toml as %q", path, got, helix)
		}
	}
	return helix
}

// database runs the launcher's db command and checks main.cpp's entry.
func database() {
	cmd := exec.Command(filepath.Join(root, "buck/toolchains/cxx/lsp/clangd"), "db")
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		fail("writing the compilation database: %v", err)
	}
	path := strings.TrimSpace(string(out))
	if !strings.HasPrefix(path, cache) {
		fail("the database %s is outside XDG_CACHE_HOME", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		fail("%v", err)
	}
	var entries []struct {
		Directory string   `json:"directory"`
		File      string   `json:"file"`
		Arguments []string `json:"arguments"`
	}
	if err := json.Unmarshal(data, &entries); err != nil {
		fail("%s: %v", path, err)
	}
	main := filepath.Join(root, tests, "hello/main.cpp")
	for _, e := range entries {
		if e.File != main {
			continue
		}
		if e.Directory != root {
			fail("main.cpp's command runs in %s", e.Directory)
		}
		if !filepath.IsAbs(e.Arguments[0]) {
			fail("main.cpp's compiler %s is not an absolute path", e.Arguments[0])
		}
		for i, a := range e.Arguments {
			if strings.HasPrefix(a, "@") {
				fail("main.cpp's command keeps the argument file %s", a)
			}
			if a == "-I" && e.Arguments[i+1] == filepath.Join(root, tests) {
				return
			}
		}
		fail("main.cpp's include path lacks %s: %q", filepath.Join(root, tests), e.Arguments)
	}
	fail("the database has no entry for %s", main)
}

// MARK: LSP

type server struct {
	cmd         *exec.Cmd
	in          io.WriteCloser
	messages    chan map[string]any
	nextID      int
	diagnostics map[string][]any
}

func start(command []string) *server {
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	// Its own process group, so that stopping it stops what it started.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		fail("%v", err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		fail("%v", err)
	}
	if err := cmd.Start(); err != nil {
		fail("starting clangd: %v", err)
	}
	s := &server{cmd: cmd, in: in, messages: make(chan map[string]any, 1024), diagnostics: map[string][]any{}}
	go s.read(bufio.NewReader(out))
	running = s
	return s
}

// The server, if one is running, which cleanup stops.
var running *server

func (s *server) stop() {
	syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	s.cmd.Wait()
}

func (s *server) read(r *bufio.Reader) {
	defer close(s.messages)
	for {
		length := -1
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSpace(line)
			if line == "" {
				break
			}
			if v, ok := strings.CutPrefix(strings.ToLower(line), "content-length:"); ok {
				length, _ = strconv.Atoi(strings.TrimSpace(v))
			}
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(body, &msg); err != nil {
			fail("clangd sent %q: %v", body, err)
		}
		s.messages <- msg
	}
}

func (s *server) send(msg map[string]any) {
	msg["jsonrpc"] = "2.0"
	body, err := json.Marshal(msg)
	if err != nil {
		fail("%v", err)
	}
	fmt.Fprintf(s.in, "Content-Length: %d\r\n\r\n%s", len(body), body)
}

func (s *server) notify(method string, params any) {
	s.send(map[string]any{"method": method, "params": params})
}

func (s *server) handle(msg map[string]any) {
	method, _ := msg["method"].(string)
	if id, ok := msg["id"]; ok && method != "" {
		s.send(map[string]any{"id": id, "result": nil})
		return
	}
	if method == "textDocument/publishDiagnostics" {
		params := msg["params"].(map[string]any)
		s.diagnostics[params["uri"].(string)], _ = params["diagnostics"].([]any)
	}
}

func (s *server) wait(what string, done func(map[string]any) bool) {
	for {
		select {
		case msg, ok := <-s.messages:
			if !ok {
				fail("clangd exited while waiting for %s", what)
			}
			s.handle(msg)
			if done(msg) {
				return
			}
		case <-time.After(time.Until(deadline)):
			fail("timed out waiting for %s", what)
		}
	}
}

func (s *server) request(method string, params any) any {
	s.nextID++
	id := float64(s.nextID)
	s.send(map[string]any{"id": id, "method": method, "params": params})
	var result any
	s.wait(method, func(msg map[string]any) bool {
		if msg["id"] != id || msg["method"] != nil {
			return false
		}
		if e, ok := msg["error"]; ok {
			fail("%s failed: %v", method, e)
		}
		result = msg["result"]
		return true
	})
	return result
}

func uri(path string) string { return "file://" + path }

// uriPath is the path of a file URI, which servers percent-encode
// (c++ as c%2B%2B).
func uriPath(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		fail("%q: %v", u, err)
	}
	return parsed.Path
}

func position(text, marker string) map[string]any {
	i := strings.Index(text, marker)
	if i < 0 {
		fail("no %q", marker)
	}
	before := text[:i]
	line := strings.Count(before, "\n")
	return map[string]any{"line": line, "character": len(before) - (strings.LastIndex(before, "\n") + 1)}
}

func definitionPaths(result any) []string {
	locs, _ := result.([]any)
	var out []string
	for _, l := range locs {
		loc := l.(map[string]any)
		u, _ := loc["targetUri"].(string)
		if u == "" {
			u, _ = loc["uri"].(string)
		}
		out = append(out, uriPath(u))
	}
	return out
}

func lsp(command []string) {
	s := start(command)
	s.request("initialize", map[string]any{
		"processId":        os.Getpid(),
		"rootUri":          uri(root),
		"workspaceFolders": []any{map[string]any{"uri": uri(root), "name": "depot"}},
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"definition":         map[string]any{"linkSupport": true},
				"publishDiagnostics": map[string]any{},
			},
		},
	})
	s.notify("initialized", map[string]any{})

	main := filepath.Join(root, tests, "hello/main.cpp")
	data, err := os.ReadFile(main)
	if err != nil {
		fail("%v", err)
	}
	text := string(data)
	s.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{
		"uri": uri(main), "languageId": "cpp", "version": 1, "text": text,
	}})
	s.wait("main.cpp's diagnostics", func(msg map[string]any) bool {
		if msg["method"] != "textDocument/publishDiagnostics" || msg["params"].(map[string]any)["uri"] != uri(main) {
			return false
		}
		var errs []string
		for _, d := range s.diagnostics[uri(main)] {
			d := d.(map[string]any)
			if d["severity"] == float64(1) {
				errs = append(errs, fmt.Sprint(d["message"]))
			}
		}
		if len(errs) > 0 {
			fail("main.cpp does not compile: %q", errs)
		}
		return true
	})

	greeting := filepath.Join(root, tests, "greeting")
	for _, w := range []struct {
		what, marker string
		match        func(string) bool
	}{
		// In the repository, not in Buck's header tree.
		{"a function the library's header declares", "greet(name)", func(p string) bool {
			return p == filepath.Join(greeting, "greeting.h") || p == filepath.Join(greeting, "greeting.cpp")
		}},
		{"a macro from a generated header", "GREETING_VERSION)", func(p string) bool {
			return strings.HasPrefix(p, filepath.Join(root, "buck-out")+"/") && strings.HasSuffix(p, "/version.h")
		}},
		{"the standard library", "vector<std::string>", func(p string) bool {
			return strings.Contains(p, "/c++/") && strings.Contains(p, "vector")
		}},
	} {
		paths := definitionPaths(s.request("textDocument/definition", map[string]any{
			"textDocument": map[string]any{"uri": uri(main)},
			"position":     position(text, w.marker),
		}))
		if len(paths) == 0 || !slices.ContainsFunc(paths, w.match) {
			fail("the definition of %s (%s) is in %q", w.marker, w.what, paths)
		}
	}

	s.request("shutdown", nil)
	s.notify("exit", nil)
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
	}
	syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	running = nil
}
