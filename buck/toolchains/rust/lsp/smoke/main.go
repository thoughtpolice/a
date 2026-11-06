// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command smoke-test drives rust-analyzer over LSP, with rust-project
// answering its discovery and checks, on the fixtures under tests/.
//
// It checks that Helix, Claude Code and OMP configure rust-analyzer alike,
// then runs rust-project the way their configuration does. It discovers
// the crates of tests/hello/main.rs, which uses a library under another
// name, a proc macro and a third-party crate through its alias, and whose
// library shares its root with its unit tests. It discovers a file no Rust
// target owns, and checks a file with a warning and one without. Then it
// starts rust-analyzer with that configuration, opens main.rs, and looks up
// the definitions of names from each kind of crate, the standard library's
// included, and saves tests/warning/lib.rs to see the build's warning
// arrive. Buck runs in the shared daemon that runs this test.
package main

import (
	"bufio"
	"bytes"
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
	tests   = "buck/toolchains/rust/lsp/tests"
)

var deadline = time.Now().Add(timeout)

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", args...)
	stopServer()
	os.Exit(1)
}

func stopServer() {
	if running != nil {
		running.stop()
	}
}

var root string

func main() {
	out, err := exec.Command("buck2", "root", "--kind", "project").Output()
	if err != nil {
		fail("buck2 root: %v", err)
	}
	root = strings.TrimSpace(string(out))

	cfg := configured()
	cli(cfg)
	lsp(cfg)
	stopServer()
	fmt.Println("PASS")
}

// The rust-analyzer configuration the editors give, in the shape of
// rust-analyzer's own settings: {"check": ..., "workspace": ...}.
type config struct {
	Server   string
	Settings map[string]any
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

// readHelix reads the rust-analyzer settings from .helix/languages.toml.
// The file keeps to TOML that is JSON on each line's right-hand side, which
// is all this understands.
func readHelix() (string, map[string]any) {
	const prefix = "language-server.rust-analyzer."
	f, err := os.Open(filepath.Join(root, ".helix/languages.toml"))
	if err != nil {
		fail("%v", err)
	}
	defer f.Close()
	settings := map[string]any{}
	var server string
	var table []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			name := strings.Trim(line, "[]")
			table = nil
			if rest, ok := strings.CutPrefix(name, prefix); ok {
				table = strings.Split(rest, ".")
			}
			continue
		}
		if table == nil {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			fail(".helix/languages.toml: cannot read %q", line)
		}
		var v any
		if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &v); err != nil {
			fail(".helix/languages.toml: %q: %v", line, err)
		}
		key = strings.TrimSpace(key)
		if slices.Equal(table, []string{"config", "server"}) && key == "path" {
			server = v.(string)
			continue
		}
		if table[0] != "config" {
			continue
		}
		m := settings
		for _, part := range table[1:] {
			next, ok := m[part].(map[string]any)
			if !ok {
				next = map[string]any{}
				m[part] = next
			}
			m = next
		}
		m[key] = v
	}
	if err := scanner.Err(); err != nil {
		fail(".helix/languages.toml: %v", err)
	}
	return server, settings
}

func configured() config {
	server, helix := readHelix()
	claude := readJSON(".claude/marketplace/lsp/.lsp.json")["rust-analyzer"].(map[string]any)
	omp := readJSON(".omp/lsp.json")["servers"].(map[string]any)["rust-analyzer"].(map[string]any)
	for path, given := range map[string][]any{
		".claude/marketplace/lsp/.lsp.json": {claude["initializationOptions"]},
		".omp/lsp.json":                     {omp["initOptions"], omp["settings"].(map[string]any)["rust-analyzer"]},
	} {
		for _, settings := range given {
			if !reflect.DeepEqual(settings, any(helix)) {
				fail("%s configures rust-analyzer differently from .helix/languages.toml:\n%v\n%v", path, settings, helix)
			}
		}
	}
	for path, command := range map[string]any{".claude/marketplace/lsp/.lsp.json": claude["command"], ".omp/lsp.json": omp["command"]} {
		if command != server {
			fail("%s starts %v, .helix/languages.toml %s", path, command, server)
		}
	}
	return config{Server: server, Settings: helix}
}

func stringList(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}

// command is the configured command with its placeholder replaced, as
// rust-analyzer replaces it.
func command(cmd []string, placeholder, value string) *exec.Cmd {
	args := slices.Clone(cmd)
	for i, a := range args {
		if a == placeholder {
			args[i] = value
		}
	}
	c := exec.Command(args[0], args[1:]...)
	c.Dir = root
	c.Stderr = os.Stderr
	return c
}

type project struct {
	Sysroot    string `json:"sysroot"`
	SysrootSrc string `json:"sysroot_src"`
	Crates     []struct {
		DisplayName       string `json:"display_name"`
		RootModule        string `json:"root_module"`
		IsWorkspaceMember bool   `json:"is_workspace_member"`
		IsProcMacro       bool   `json:"is_proc_macro"`
		ProcMacroDylib    string `json:"proc_macro_dylib_path"`
		Cfg               []string
		Deps              []struct {
			Crate int    `json:"crate"`
			Name  string `json:"name"`
		} `json:"deps"`
		Build *struct {
			Label      string `json:"label"`
			TargetKind string `json:"target_kind"`
		} `json:"build"`
	} `json:"crates"`
}

func discover(cfg config, file string) (string, *project) {
	dc := cfg.Settings["workspace"].(map[string]any)["discoverConfig"].(map[string]any)
	arg, _ := json.Marshal(map[string]string{"path": file})
	out, err := command(stringList(dc["command"]), "{arg}", string(arg)).Output()
	if err != nil {
		fail("discovering %s: %v", file, err)
	}
	var last map[string]json.RawMessage
	for line := range bytes.Lines(out) {
		var msg map[string]json.RawMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			fail("discovering %s: %q: %v", file, line, err)
		}
		last = msg
	}
	var kind string
	json.Unmarshal(last["kind"], &kind)
	if kind == "error" {
		var msg string
		json.Unmarshal(last["error"], &msg)
		return msg, nil
	}
	if kind != "finished" {
		fail("discovering %s ended with %s", file, out)
	}
	var p project
	if err := json.Unmarshal(last["project"], &p); err != nil {
		fail("%v", err)
	}
	return "", &p
}

func check(cfg config, file string) []map[string]any {
	cc := cfg.Settings["check"].(map[string]any)
	out, err := command(stringList(cc["overrideCommand"]), "$saved_file", file).Output()
	if err != nil {
		fail("checking %s: %v", file, err)
	}
	var msgs []map[string]any
	for line := range bytes.Lines(out) {
		var msg map[string]any
		if err := json.Unmarshal(line, &msg); err != nil {
			fail("checking %s: %q: %v", file, line, err)
		}
		msgs = append(msgs, msg)
	}
	return msgs
}

func cli(cfg config) {
	hello := filepath.Join(root, tests, "hello/main.rs")
	greeting := filepath.Join(root, tests, "greeting/lib.rs")
	errMsg, p := discover(cfg, hello)
	if p == nil {
		fail("discovering %s: %s", hello, errMsg)
	}
	if _, err := os.Stat(p.SysrootSrc); err != nil {
		fail("sysroot_src: %v", err)
	}
	byRoot := map[string]int{}
	for i, c := range p.Crates {
		if _, ok := byRoot[c.RootModule]; ok {
			fail("two crates have the root module %s", c.RootModule)
		}
		byRoot[c.RootModule] = i
	}
	h, ok := byRoot[hello]
	if !ok {
		fail("no crate has the root module %s", hello)
	}
	main := p.Crates[h]
	if !main.IsWorkspaceMember || main.Build == nil || main.Build.TargetKind != "bin" || !slices.Contains(main.Cfg, "test") {
		fail("hello is not a workspace binary with cfg(test): %+v", main)
	}
	deps := map[string]int{}
	for _, d := range main.Deps {
		deps[d.Name] = d.Crate
	}
	for _, name := range []string{"anyhow", "answer", "mimalloc", "salutation"} {
		if _, ok := deps[name]; !ok {
			fail("hello's dependencies %v lack %s", deps, name)
		}
	}
	if p.Crates[deps["salutation"]].RootModule != greeting {
		fail("salutation is %s, not the greeting library", p.Crates[deps["salutation"]].RootModule)
	}
	answer := p.Crates[deps["answer"]]
	if !answer.IsProcMacro {
		fail("answer is not a proc macro")
	}
	if _, err := os.Stat(answer.ProcMacroDylib); err != nil {
		fail("answer's dylib: %v", err)
	}
	if slices.Contains(p.Crates[deps["anyhow"]].Cfg, "test") {
		fail("third-party anyhow has cfg(test)")
	}

	// From its own file, the greeting library is in the workspace, its unit
	// tests folded in.
	_, p = discover(cfg, greeting)
	if p == nil {
		fail("discovering %s failed", greeting)
	}
	found := false
	for _, c := range p.Crates {
		if c.RootModule == greeting {
			if found {
				fail("two crates for %s", greeting)
			}
			found = true
			if c.Build == nil || !strings.HasSuffix(c.Build.Label, ":greeting-test") || c.Build.TargetKind != "test" {
				fail("greeting's build is not its test's: %+v", c.Build)
			}
		}
	}
	if !found {
		fail("no crate for %s", greeting)
	}

	notRust := filepath.Join(root, "buck/toolchains/rust/lsp/main.go")
	if errMsg, p := discover(cfg, notRust); p != nil || !strings.Contains(errMsg, "no Rust target owns") {
		fail("discovering %s: %q", notRust, errMsg)
	}

	warning := filepath.Join(root, tests, "warning/lib.rs")
	if !hasWarning(check(cfg, warning), warning) {
		fail("checking %s reported no unused variable", warning)
	}
	for _, msg := range check(cfg, hello) {
		if spans, _ := msg["spans"].([]any); len(spans) > 0 {
			fail("checking %s: %v", hello, msg["rendered"])
		}
	}
}

func hasWarning(msgs []map[string]any, file string) bool {
	for _, msg := range msgs {
		text, _ := msg["message"].(string)
		spans, _ := msg["spans"].([]any)
		if !strings.Contains(text, "unused variable") || len(spans) == 0 {
			continue
		}
		if span, _ := spans[0].(map[string]any); span["file_name"] == file {
			return true
		}
	}
	return false
}

// MARK: LSP

type server struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	messages chan map[string]any
	nextID   int
	// Diagnostics published for each URI, by source.
	diagnostics map[string][]map[string]any
}

func start(cfg config) *server {
	cmd := exec.Command(cfg.Server)
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
		fail("starting %s: %v", cfg.Server, err)
	}
	s := &server{cmd: cmd, in: in, messages: make(chan map[string]any, 1024), diagnostics: map[string][]map[string]any{}}
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
			fail("server sent %q: %v", body, err)
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

// handle answers the server's own requests and keeps its diagnostics.
func (s *server) handle(msg map[string]any) {
	method, _ := msg["method"].(string)
	if id, ok := msg["id"]; ok && method != "" {
		// registerCapability, workDoneProgress/create and the like.
		s.send(map[string]any{"id": id, "result": nil})
		return
	}
	if method == "textDocument/publishDiagnostics" {
		params := msg["params"].(map[string]any)
		var diags []map[string]any
		for _, d := range params["diagnostics"].([]any) {
			diags = append(diags, d.(map[string]any))
		}
		s.diagnostics[params["uri"].(string)] = diags
	}
}

// wait handles messages until done says to stop, or the deadline passes.
func (s *server) wait(what string, done func(map[string]any) bool) {
	for {
		select {
		case msg, ok := <-s.messages:
			if !ok {
				fail("rust-analyzer exited while waiting for %s", what)
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
			// Requests made while the workspace loads can be cancelled.
			result = e
			return true
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

// position is where the first occurrence of `marker` in `text` starts,
// plus `offset` characters.
func position(text, marker string, offset int) map[string]any {
	i := strings.Index(text, marker)
	if i < 0 {
		fail("no %q", marker)
	}
	before := text[:i]
	line := strings.Count(before, "\n")
	col := len(before) - (strings.LastIndex(before, "\n") + 1) + offset
	return map[string]any{"line": line, "character": col}
}

// definitionPath is the file the definition at pos lies in, or "" while
// rust-analyzer does not know.
func definitionPath(result any) string {
	locs, ok := result.([]any)
	if !ok || len(locs) == 0 {
		return ""
	}
	loc := locs[0].(map[string]any)
	u, _ := loc["targetUri"].(string)
	if u == "" {
		u, _ = loc["uri"].(string)
	}
	return uriPath(u)
}

func lsp(cfg config) {
	s := start(cfg)
	s.request("initialize", map[string]any{
		"processId":             os.Getpid(),
		"rootUri":               uri(root),
		"workspaceFolders":      []any{map[string]any{"uri": uri(root), "name": "depot"}},
		"initializationOptions": cfg.Settings,
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"synchronization": map[string]any{"didSave": true},
				"definition":      map[string]any{"linkSupport": true},
				"publishDiagnostics": map[string]any{
					"relatedInformation": true,
				},
			},
			"window": map[string]any{"workDoneProgress": true},
		},
	})
	s.notify("initialized", map[string]any{})

	hello := filepath.Join(root, tests, "hello/main.rs")
	data, err := os.ReadFile(hello)
	if err != nil {
		fail("%v", err)
	}
	text := string(data)
	s.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{
		"uri": uri(hello), "languageId": "rust", "version": 1, "text": text,
	}})

	greeting := filepath.Join(root, tests, "greeting/lib.rs")
	answer := filepath.Join(root, tests, "answer/lib.rs")
	want := []struct {
		what   string
		marker string
		offset int
		match  func(string) bool
	}{
		{"a renamed library", "greet(", 0, func(p string) bool { return p == greeting }},
		// Only an expanded macro's items have a definition, which
		// rust-analyzer places at the call or in the macro, by the spans
		// the macro gave its output.
		{"a function a proc macro defines", "answer())", 0, func(p string) bool { return p == hello || p == answer }},
		{"a third-party crate through its alias", "Result<()>", 0, func(p string) bool { return strings.Contains(p, "/anyhow-") }},
		{"the standard library", "String =", 0, func(p string) bool { return strings.HasSuffix(p, "/alloc/src/string.rs") }},
	}
	for _, w := range want {
		pos := position(text, w.marker, w.offset)
		for {
			path := definitionPath(s.request("textDocument/definition", map[string]any{
				"textDocument": map[string]any{"uri": uri(hello)},
				"position":     pos,
			}))
			if path != "" && w.match(path) {
				break
			}
			if path != "" {
				fail("the definition of %s (%s) is in %s", w.marker, w.what, path)
			}
			if time.Now().After(deadline) {
				fail("no definition of %s (%s)", w.marker, w.what)
			}
			// Still loading the workspace, or building the proc macros.
			s.drain(time.Second)
		}
	}

	// Saving runs the configured check, whose diagnostics carry rustc or
	// clippy as their source; rust-analyzer's own are "rust-analyzer".
	warning := filepath.Join(root, tests, "warning/lib.rs")
	data, err = os.ReadFile(warning)
	if err != nil {
		fail("%v", err)
	}
	s.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{
		"uri": uri(warning), "languageId": "rust", "version": 1, "text": string(data),
	}})
	s.notify("textDocument/didSave", map[string]any{"textDocument": map[string]any{"uri": uri(warning)}})
	saved := time.Now()
	s.wait("the check of "+warning, func(map[string]any) bool {
		for _, d := range s.diagnostics[uri(warning)] {
			msg, _ := d["message"].(string)
			if d["source"] != "rust-analyzer" && strings.Contains(msg, "unused variable") {
				return true
			}
		}
		// rust-analyzer checks only once the file's workspace has loaded;
		// save again until it has.
		if time.Since(saved) > 5*time.Second {
			s.notify("textDocument/didSave", map[string]any{"textDocument": map[string]any{"uri": uri(warning)}})
			saved = time.Now()
		}
		return false
	})

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

// drain handles whatever the server sends for d.
func (s *server) drain(d time.Duration) {
	end := time.After(d)
	for {
		select {
		case msg, ok := <-s.messages:
			if !ok {
				fail("rust-analyzer exited")
			}
			s.handle(msg)
		case <-end:
			return
		}
	}
}
