// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ReadMessage reads one LSP base-protocol message body.
func ReadMessage(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, _ := strings.Cut(line, ":")
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			length, err = strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("bad Content-Length %q", value)
			}
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("message without Content-Length")
	}
	body := make([]byte, length)
	_, err := io.ReadFull(r, body)
	return body, err
}

func WriteMessage(w io.Writer, body []byte) error {
	_, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

// envelope is the part of a JSON-RPC message the proxy routes on.
type envelope struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
}

func decode(data []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	err := decoder.Decode(&value)
	return value, err
}

func object(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// ownRequest prefixes the ids of requests the proxy itself sends the client,
// so their responses are not forwarded to the server.
const ownRequest = "celld-project/"

var sourceExtensions = map[string]bool{
	".ts": true, ".tsx": true, ".mts": true, ".cts": true,
	".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
}

func isBuildFile(path string) bool {
	base := filepath.Base(path)
	return base == "BUILD" || base == "PACKAGE"
}

func uriPath(uri string) (string, bool) {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return "", false
	}
	return filepath.Clean(u.Path), true
}

func pathURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

// Proxy sits between an editor and `deno lsp` and relays every message, with
// these changes: `initialize`, `workspace/didChangeConfiguration` and the
// editor's answers to `workspace/configuration` carry the generated config's
// path in their `deno` settings; opening a file no known unit covers asks the
// Discoverer for its units, in the background, and rewrites that config; a
// change to a BUILD or PACKAGE file forgets everything and asks again for the
// open files.
//
// Deno reloads the rewritten config when told the file changed
// (`workspace/didChangeWatchedFiles`), and then re-checks the open documents.
// A `workspace/didChangeConfiguration` would reload it too, but leaves stale
// diagnostics until the next edit, so the proxy does not use it. Even after
// the watched-file reload, Deno 2.9 keeps a document's old module resolution
// for navigation (go-to-definition lands on the import) until that document
// is edited; closing and reopening it does not help. So the messages about a
// document whose units are being discovered are held back, up to Hold, and
// reach Deno after the reload: the document then opens with its imports
// already mapped. Messages about other documents keep flowing. Deno handles
// the reload asynchronously, so "after" means after it reports the change
// back (`deno/didChangeDenoConfiguration`, which it sends for every changed
// config file); the Hold timeout covers a server that never does.
type Proxy struct {
	Root       string
	ConfigPath string
	Discover   Discoverer
	// How long to hold a document's messages while its units are discovered.
	Hold time.Duration
	// Called after each discovery round, once the config is written.
	OnDiscovered func()

	clientMu sync.Mutex
	client   io.Writer
	serverMu sync.Mutex
	server   io.Writer

	mu             sync.Mutex
	fragments      []*Fragment
	known          map[string]bool
	resolved       map[string]bool
	pending        map[string]bool
	queued         map[string]bool
	open           map[string]string
	held           map[string][][]byte
	reloading      [][]string
	configRequests map[string][]any
	watch          bool
	rediscover     bool
	requests       int
	wake           chan struct{}
}

func (p *Proxy) sendClient(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	p.clientMu.Lock()
	defer p.clientMu.Unlock()
	WriteMessage(p.client, body)
}

func (p *Proxy) sendServer(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	p.forwardServer(body)
}

func (p *Proxy) forwardClient(body []byte) {
	p.clientMu.Lock()
	defer p.clientMu.Unlock()
	WriteMessage(p.client, body)
}

func (p *Proxy) forwardServer(body []byte) {
	p.serverMu.Lock()
	defer p.serverMu.Unlock()
	WriteMessage(p.server, body)
}

// Message types of window/logMessage.
const (
	logError   = 1
	logWarning = 2
	logInfo    = 3
)

func (p *Proxy) log(kind int, format string, args ...any) {
	text := "celld-project: " + fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, text)
	p.sendClient(map[string]any{
		"method": "window/logMessage",
		"params": map[string]any{"type": kind, "message": text},
	})
}

// Run relays between the editor and the server until the server's output
// ends. It closes serverIn when the editor's input ends.
func (p *Proxy) Run(clientIn io.Reader, clientOut io.Writer, serverIn io.WriteCloser, serverOut io.Reader) error {
	p.client = clientOut
	p.server = serverIn
	p.known = map[string]bool{}
	p.resolved = map[string]bool{}
	p.pending = map[string]bool{}
	p.queued = map[string]bool{}
	p.open = map[string]string{}
	p.held = map[string][][]byte{}
	p.configRequests = map[string][]any{}
	p.wake = make(chan struct{}, 1)
	if _, err := WriteConfig(p.ConfigPath, Merge(p.Root, nil, func(string) {})); err != nil {
		return err
	}
	go p.discoverLoop()
	go func() {
		reader := bufio.NewReader(clientIn)
		for {
			body, err := ReadMessage(reader)
			if err != nil {
				break
			}
			p.fromClient(body)
		}
		serverIn.Close()
	}()
	reader := bufio.NewReader(serverOut)
	for {
		body, err := ReadMessage(reader)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		p.fromServer(body)
	}
}

func (p *Proxy) fromServer(body []byte) {
	var env envelope
	json.Unmarshal(body, &env)
	if env.Method == "deno/didChangeDenoConfiguration" {
		// The editor sees it first, then the documents follow.
		p.forwardClient(body)
		p.reloaded(env.Params)
		return
	}
	if env.Method == "workspace/configuration" && len(env.ID) > 0 {
		var params struct {
			Items []any `json:"items"`
		}
		json.Unmarshal(env.Params, &params)
		p.mu.Lock()
		p.configRequests[string(env.ID)] = params.Items
		p.mu.Unlock()
	}
	p.forwardClient(body)
}

func (p *Proxy) fromClient(body []byte) {
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		p.forwardServer(body)
		return
	}
	if env.Method != "" && p.hold(env.Params, body) {
		return
	}
	switch env.Method {
	case "":
		p.fromClientResponse(env, body)
	case "initialize":
		p.forwardServer(p.rewrite(body, func(message map[string]any) {
			params := object(message["params"])
			options := object(params["initializationOptions"])
			options["config"] = p.ConfigPath
			params["initializationOptions"] = options
			message["params"] = params
			capabilities := object(object(object(params["capabilities"])["workspace"])["didChangeWatchedFiles"])
			dynamic, _ := capabilities["dynamicRegistration"].(bool)
			p.mu.Lock()
			p.watch = dynamic
			p.mu.Unlock()
		}))
	case "initialized":
		p.forwardServer(body)
		p.registerWatchers()
	case "workspace/didChangeConfiguration":
		p.forwardServer(p.rewrite(body, func(message map[string]any) {
			settings, ok := object(message["params"])["settings"].(map[string]any)
			if !ok {
				return
			}
			if deno, ok := settings["deno"].(map[string]any); ok {
				deno["config"] = p.ConfigPath
			}
		}))
	case "textDocument/didOpen":
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		json.Unmarshal(env.Params, &params)
		p.opened(params.TextDocument.URI, body)
	case "textDocument/didClose":
		p.forwardServer(body)
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		json.Unmarshal(env.Params, &params)
		p.mu.Lock()
		delete(p.open, params.TextDocument.URI)
		p.mu.Unlock()
	case "textDocument/didSave":
		p.forwardServer(body)
		var params struct {
			TextDocument struct {
				URI string `json:"uri"`
			} `json:"textDocument"`
		}
		json.Unmarshal(env.Params, &params)
		if path, ok := uriPath(params.TextDocument.URI); ok && isBuildFile(path) {
			p.invalidate()
		}
	case "workspace/didChangeWatchedFiles":
		p.forwardServer(body)
		var params struct {
			Changes []struct {
				URI string `json:"uri"`
			} `json:"changes"`
		}
		json.Unmarshal(env.Params, &params)
		for _, change := range params.Changes {
			if path, ok := uriPath(change.URI); ok && isBuildFile(path) {
				p.invalidate()
				break
			}
		}
	default:
		p.forwardServer(body)
	}
}

func (p *Proxy) fromClientResponse(env envelope, body []byte) {
	var own string
	if json.Unmarshal(env.ID, &own) == nil && strings.HasPrefix(own, ownRequest) {
		return
	}
	p.mu.Lock()
	items, ok := p.configRequests[string(env.ID)]
	delete(p.configRequests, string(env.ID))
	p.mu.Unlock()
	if !ok {
		p.forwardServer(body)
		return
	}
	p.forwardServer(p.rewrite(body, func(message map[string]any) {
		results, ok := message["result"].([]any)
		if !ok {
			return
		}
		for i, item := range items {
			if i >= len(results) || object(item)["section"] != "deno" {
				continue
			}
			settings := object(results[i])
			settings["config"] = p.ConfigPath
			results[i] = settings
		}
	}))
}

// rewrite applies edit to a decoded message and re-encodes it; a message that
// does not decode is passed on as it is.
func (p *Proxy) rewrite(body []byte, edit func(map[string]any)) []byte {
	message, err := decode(body)
	if err != nil {
		return body
	}
	edit(message)
	out, err := json.Marshal(message)
	if err != nil {
		return body
	}
	return out
}

func (p *Proxy) registerWatchers() {
	p.mu.Lock()
	watch := p.watch
	p.requests++
	id := fmt.Sprintf("%swatch-%d", ownRequest, p.requests)
	p.mu.Unlock()
	if !watch {
		return
	}
	p.sendClient(map[string]any{
		"id":     id,
		"method": "client/registerCapability",
		"params": map[string]any{
			"registrations": []any{map[string]any{
				"id":     "celld-project-build-files",
				"method": "workspace/didChangeWatchedFiles",
				"registerOptions": map[string]any{
					"watchers": []any{
						map[string]any{"globPattern": "**/BUILD"},
						map[string]any{"globPattern": "**/PACKAGE"},
					},
				},
			}},
		},
	})
}

// eligible reports whether path is an existing source file in the project,
// outside buck-out.
func (p *Proxy) eligible(path string) bool {
	if !sourceExtensions[filepath.Ext(path)] {
		return false
	}
	rel, err := filepath.Rel(p.Root, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || strings.HasPrefix(rel, "buck-out"+string(filepath.Separator)) {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// candidate reports whether discovery should look path up; p.mu must be held.
func (p *Proxy) candidate(path string) bool {
	dir := filepath.Dir(path)
	return !p.known[path] && !p.resolved[dir] && !p.pending[dir] && p.eligible(path)
}

// opened forwards a didOpen, or holds it while the document's units are
// discovered.
func (p *Proxy) opened(uri string, body []byte) {
	path, ok := uriPath(uri)
	p.mu.Lock()
	queue := ok && p.candidate(path)
	if ok {
		p.open[uri] = path
	}
	if queue {
		p.queued[path] = true
		p.pending[filepath.Dir(path)] = true
		if p.Hold > 0 {
			p.held[uri] = [][]byte{body}
			time.AfterFunc(p.Hold, func() { p.release([]string{uri}) })
		}
	}
	if !queue || p.Hold <= 0 {
		p.forwardServer(body)
	}
	p.mu.Unlock()
	if queue {
		p.signal()
	}
}

// hold keeps a message about a held document for later, and reports whether
// it did.
func (p *Proxy) hold(params json.RawMessage, body []byte) bool {
	var document struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if json.Unmarshal(params, &document) != nil || document.TextDocument.URI == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	messages, ok := p.held[document.TextDocument.URI]
	if ok {
		p.held[document.TextDocument.URI] = append(messages, body)
	}
	return ok
}

// releasePaths releases the held documents at some paths. Editors spell
// URIs in their own ways, so this goes by path.
func (p *Proxy) releasePaths(paths []string) {
	wanted := map[string]bool{}
	for _, path := range paths {
		wanted[path] = true
	}
	var uris []string
	p.mu.Lock()
	for uri := range p.held {
		if path, ok := uriPath(uri); ok && wanted[path] {
			uris = append(uris, uri)
		}
	}
	p.mu.Unlock()
	p.release(uris)
}

// release forwards the held messages of some documents, in order.
func (p *Proxy) release(uris []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, uri := range uris {
		for _, body := range p.held[uri] {
			p.forwardServer(body)
		}
		delete(p.held, uri)
	}
}

func (p *Proxy) invalidate() {
	p.mu.Lock()
	p.rediscover = true
	p.resolved = map[string]bool{}
	for _, path := range p.open {
		if p.eligible(path) {
			p.queued[path] = true
			p.pending[filepath.Dir(path)] = true
		}
	}
	p.mu.Unlock()
	p.signal()
}

func (p *Proxy) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Proxy) discoverLoop() {
	for range p.wake {
		p.mu.Lock()
		files := sortedKeys(p.queued)
		p.queued = map[string]bool{}
		replace := p.rediscover
		p.rediscover = false
		p.mu.Unlock()
		if len(files) == 0 && !replace {
			continue
		}
		if p.discoverRound(files, replace) {
			// Released when Deno reports the reload.
			p.mu.Lock()
			p.reloading = append(p.reloading, files)
			p.mu.Unlock()
		} else {
			p.releasePaths(files)
		}
		if p.OnDiscovered != nil {
			p.OnDiscovered()
		}
	}
}

// discoverRound looks files up, rewrites the config and tells the server; it
// reports whether it did the last.
func (p *Proxy) discoverRound(files []string, replace bool) bool {
	var fragments []*Fragment
	var err error
	start := time.Now()
	if len(files) > 0 {
		fragments, err = p.Discover.Discover(files)
	}
	elapsed := time.Since(start).Round(10 * time.Millisecond)
	p.mu.Lock()
	for _, file := range files {
		dir := filepath.Dir(file)
		delete(p.pending, dir)
		p.resolved[dir] = true
	}
	if err != nil {
		p.mu.Unlock()
		p.log(logError, "could not find the units of %s: %v", strings.Join(files, " "), err)
		return false
	}
	if replace {
		p.fragments = nil
		p.known = map[string]bool{}
	}
	var added []string
	for _, fragment := range fragments {
		replaced := false
		for i, existing := range p.fragments {
			if existing.Label == fragment.Label {
				p.fragments[i] = fragment
				replaced = true
			}
		}
		if !replaced {
			p.fragments = append(p.fragments, fragment)
			added = append(added, fragment.Label)
		}
		for _, file := range fragment.Files {
			p.known[filepath.Join(p.Root, file)] = true
		}
	}
	var warnings []string
	config := Merge(p.Root, p.fragments, func(w string) { warnings = append(warnings, w) })
	p.mu.Unlock()

	for _, warning := range warnings {
		p.log(logWarning, "%s", warning)
	}
	if len(added) > 0 {
		sort.Strings(added)
		p.log(logInfo, "serving %s (found in %s)", strings.Join(added, " "), elapsed)
	}
	changed, err := WriteConfig(p.ConfigPath, config)
	if err != nil {
		p.log(logError, "writing %s: %v", p.ConfigPath, err)
		return false
	}
	if changed {
		p.sendServer(map[string]any{
			"method": "workspace/didChangeWatchedFiles",
			"params": map[string]any{
				"changes": []any{map[string]any{"uri": pathURI(p.ConfigPath), "type": 2}},
			},
		})
	}
	return changed
}

// reloaded releases the documents of the oldest reload Deno has not yet
// reported, if the notification reports the config.
func (p *Proxy) reloaded(params json.RawMessage) {
	var report struct {
		Changes []struct {
			FileURI string `json:"fileUri"`
			Type    string `json:"type"`
		} `json:"changes"`
	}
	json.Unmarshal(params, &report)
	for _, change := range report.Changes {
		if path, ok := uriPath(change.FileURI); !ok || path != p.ConfigPath || change.Type != "changed" {
			continue
		}
		p.mu.Lock()
		if len(p.reloading) == 0 {
			p.mu.Unlock()
			return
		}
		files := p.reloading[0]
		p.reloading = p.reloading[1:]
		p.mu.Unlock()
		p.releasePaths(files)
		return
	}
}
