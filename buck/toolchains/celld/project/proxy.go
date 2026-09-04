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

// outbox writes messages to one peer from its own goroutine, in the order
// they were sent. Sending never blocks, so no lock the proxy holds and no
// reading loop ever waits on a peer that is not reading: Deno blocks writing
// to its stdout while its stdin is full, and the proxy must keep draining
// that stdout.
type outbox struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  [][]byte
	closed bool
	done   chan struct{}
}

// newOutbox starts writing to w; finish runs once the outbox is closed and
// everything sent before has been written (or writing failed).
func newOutbox(w io.Writer, finish func()) *outbox {
	o := &outbox{done: make(chan struct{})}
	o.cond = sync.NewCond(&o.mu)
	go func() {
		defer close(o.done)
		if finish != nil {
			defer finish()
		}
		broken := false
		for {
			o.mu.Lock()
			for len(o.queue) == 0 && !o.closed {
				o.cond.Wait()
			}
			batch := o.queue
			o.queue = nil
			closed := o.closed
			o.mu.Unlock()
			for _, body := range batch {
				// After a failed write the peer is gone; drop the rest.
				if !broken && WriteMessage(w, body) != nil {
					broken = true
				}
			}
			if closed && len(batch) == 0 {
				return
			}
		}
	}()
	return o
}

func (o *outbox) send(body []byte) {
	o.mu.Lock()
	if !o.closed {
		o.queue = append(o.queue, body)
	}
	o.mu.Unlock()
	o.cond.Signal()
}

// close stops accepting messages; the ones already sent are still written.
func (o *outbox) close() {
	o.mu.Lock()
	o.closed = true
	o.mu.Unlock()
	o.cond.Signal()
}

// reload is one config write the server has been told about, and the files
// whose documents wait for the server to report it.
type reload struct {
	files []string
	done  chan struct{}
}

// failure is a lookup that failed, and when to try it again.
type failure struct {
	retry time.Time
	delay time.Duration
}

// Proxy sits between an editor and `deno lsp` and relays every message, with
// these changes: `initialize`, `workspace/didChangeConfiguration` and the
// editor's answers to `workspace/configuration` carry the generated config's
// path in their `deno` settings; opening a file no known unit covers asks the
// Discoverer for its units, in the background, and rewrites that config; a
// change to a build file, a PACKAGE file or a .bzl file forgets everything
// and asks again for the open files.
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
//
// Deno's report does not say which write it saw, so the proxy has at most
// one reload in flight: the next round's write waits for the report (or the
// Hold timeout), and a report while none is in flight changes nothing.
type Proxy struct {
	Root       string
	ConfigPath string
	Discover   Discoverer
	// How long to hold a document's messages while its units are discovered.
	Hold time.Duration
	// Names of the files that define Buck packages (buildfile.name); changes
	// to them, to PACKAGE files and to .bzl files start discovery over.
	// Empty means BUILD and BUCK.
	BuildFiles []string
	// How long after a failed lookup a file may be looked up again; each
	// further failure doubles it, up to MaxRetryDelay.
	RetryDelay    time.Duration
	MaxRetryDelay time.Duration
	// Called after each discovery round, once the config is written.
	OnDiscovered func()

	client *outbox
	server *outbox

	mu         sync.Mutex
	fragments  []*Fragment
	known      map[string]bool     // files of the known units' closures
	resolved   map[string]bool     // files looked up
	pending    map[string]bool     // files being looked up
	failed     map[string]*failure // files whose lookup failed
	queued     map[string]bool
	open       map[string]string
	held       map[string][][]byte
	inFlight   *reload
	configReqs map[string][]any
	watch      bool
	rediscover bool
	requests   int
	wake       chan struct{}
}

const (
	defaultRetryDelay    = 2 * time.Second
	defaultMaxRetryDelay = 5 * time.Minute
)

func (p *Proxy) sendClient(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	p.client.send(body)
}

func (p *Proxy) sendServer(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	p.server.send(body)
}

func (p *Proxy) forwardClient(body []byte) { p.client.send(body) }
func (p *Proxy) forwardServer(body []byte) { p.server.send(body) }

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

func (p *Proxy) buildFileNames() []string {
	if len(p.BuildFiles) > 0 {
		return p.BuildFiles
	}
	return []string{"BUILD", "BUCK"}
}

// buildInput reports whether a change to path can change what Buck says
// about the units: a build file, a PACKAGE file or Starlark.
func (p *Proxy) buildInput(path string) bool {
	base := filepath.Base(path)
	if base == "PACKAGE" || strings.HasSuffix(base, ".bzl") {
		return true
	}
	for _, name := range p.buildFileNames() {
		if base == name {
			return true
		}
	}
	return false
}

// Run relays between the editor and the server until the server's output
// ends. It closes serverIn when the editor's input ends.
func (p *Proxy) Run(clientIn io.Reader, clientOut io.Writer, serverIn io.WriteCloser, serverOut io.Reader) error {
	p.client = newOutbox(clientOut, nil)
	p.server = newOutbox(serverIn, func() { serverIn.Close() })
	p.known = map[string]bool{}
	p.resolved = map[string]bool{}
	p.pending = map[string]bool{}
	p.failed = map[string]*failure{}
	p.queued = map[string]bool{}
	p.open = map[string]string{}
	p.held = map[string][][]byte{}
	p.configReqs = map[string][]any{}
	p.wake = make(chan struct{}, 1)
	if p.RetryDelay <= 0 {
		p.RetryDelay = defaultRetryDelay
	}
	if p.MaxRetryDelay < p.RetryDelay {
		p.MaxRetryDelay = max(defaultMaxRetryDelay, p.RetryDelay)
	}
	defer func() {
		// Whatever the server said last (a shutdown answer, say) still
		// reaches the editor.
		p.client.close()
		<-p.client.done
	}()
	if _, err := WriteConfig(p.ConfigPath, Merge(p.Root, nil, func(string) {})); err != nil {
		p.server.close()
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
		p.server.close()
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
		p.configReqs[string(env.ID)] = params.Items
		p.mu.Unlock()
	}
	p.forwardClient(body)
}

// documentURI is the `textDocument.uri` of a message's params, if any.
func documentURI(params json.RawMessage) string {
	var document struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if json.Unmarshal(params, &document) != nil {
		return ""
	}
	return document.TextDocument.URI
}

func (p *Proxy) fromClient(body []byte) {
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		p.forwardServer(body)
		return
	}
	uri := documentURI(env.Params)
	// Which documents are open is the proxy's own state, kept even while
	// their messages are held.
	switch env.Method {
	case "textDocument/didOpen":
		if path, ok := uriPath(uri); ok {
			p.mu.Lock()
			p.open[uri] = path
			p.mu.Unlock()
		}
	case "textDocument/didClose":
		p.mu.Lock()
		delete(p.open, uri)
		p.mu.Unlock()
	}
	if env.Method != "" && p.hold(uri, body) {
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
		p.opened(uri, body)
	case "textDocument/didChange":
		p.forwardServer(body)
		p.retry(uri)
	case "textDocument/didSave":
		p.forwardServer(body)
		if path, ok := uriPath(uri); ok && p.buildInput(path) {
			p.invalidate()
		} else {
			p.retry(uri)
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
			if path, ok := uriPath(change.URI); ok && p.buildInput(path) {
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
	items, ok := p.configReqs[string(env.ID)]
	delete(p.configReqs, string(env.ID))
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
	var watchers []any
	for _, name := range append(p.buildFileNames(), "PACKAGE") {
		watchers = append(watchers, map[string]any{"globPattern": "**/" + name})
	}
	watchers = append(watchers, map[string]any{"globPattern": "**/*.bzl"})
	p.sendClient(map[string]any{
		"id":     id,
		"method": "client/registerCapability",
		"params": map[string]any{
			"registrations": []any{map[string]any{
				"id":              "celld-project-build-files",
				"method":          "workspace/didChangeWatchedFiles",
				"registerOptions": map[string]any{"watchers": watchers},
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

// candidate reports whether discovery should look an eligible path up; p.mu
// must be held. Coverage is per file: two units can own files in the same
// directory (a library and its test), so a directory that has been looked up
// says nothing about its other files.
func (p *Proxy) candidate(path string, now time.Time) bool {
	if p.known[path] || p.resolved[path] || p.pending[path] {
		return false
	}
	if f := p.failed[path]; f != nil && now.Before(f.retry) {
		return false
	}
	return true
}

// enqueue queues path for discovery; p.mu must be held.
func (p *Proxy) enqueue(path string) {
	p.queued[path] = true
	p.pending[path] = true
}

// opened forwards a didOpen, or holds it while the document's units are
// discovered.
func (p *Proxy) opened(uri string, body []byte) {
	path, ok := uriPath(uri)
	eligible := ok && p.eligible(path)
	p.mu.Lock()
	queue := eligible && p.candidate(path, time.Now())
	if queue {
		p.enqueue(path)
		if p.Hold > 0 {
			p.held[uri] = [][]byte{body}
			time.AfterFunc(p.Hold, func() { p.release([]string{uri}) })
		}
	}
	p.mu.Unlock()
	if !queue || p.Hold <= 0 {
		p.forwardServer(body)
	}
	if queue {
		p.signal()
	}
}

// retry looks an open document up again if its last lookup failed and the
// failure's delay has passed; editing or saving it is the trigger.
func (p *Proxy) retry(uri string) {
	path, ok := uriPath(uri)
	if !ok {
		return
	}
	p.mu.Lock()
	_, isOpen := p.open[uri]
	queue := isOpen && p.failed[path] != nil && p.candidate(path, time.Now())
	p.mu.Unlock()
	if !queue || !p.eligible(path) {
		return
	}
	p.mu.Lock()
	p.enqueue(path)
	p.mu.Unlock()
	p.signal()
}

// hold keeps a message about a held document for later, and reports whether
// it did.
func (p *Proxy) hold(uri string, body []byte) bool {
	if uri == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	messages, ok := p.held[uri]
	if ok {
		p.held[uri] = append(messages, body)
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

// release forwards the held messages of some documents, in order. The
// outbox only queues them, so holding p.mu here blocks on nothing.
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
	var paths []string
	for _, path := range p.open {
		paths = append(paths, path)
	}
	p.mu.Unlock()
	var eligible []string
	for _, path := range paths {
		if p.eligible(path) {
			eligible = append(eligible, path)
		}
	}
	p.mu.Lock()
	p.rediscover = true
	p.resolved = map[string]bool{}
	p.failed = map[string]*failure{}
	for _, path := range eligible {
		p.enqueue(path)
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
		r := p.discoverRound(files, replace)
		if r == nil {
			p.releasePaths(files)
		}
		if p.OnDiscovered != nil {
			p.OnDiscovered()
		}
		if r != nil && p.Hold > 0 {
			// One reload in flight: wait for Deno's report before the next
			// round writes the config again.
			select {
			case <-r.done:
			case <-time.After(p.Hold):
				p.mu.Lock()
				if p.inFlight == r {
					p.inFlight = nil
				}
				p.mu.Unlock()
				p.releasePaths(r.files)
			}
		}
	}
}

// discoverRound looks files up, rewrites the config and tells the server. It
// returns the reload the server was told about, or nil when it told nothing.
func (p *Proxy) discoverRound(files []string, replace bool) *reload {
	var fragments []*Fragment
	var err error
	start := time.Now()
	if len(files) > 0 {
		fragments, err = p.Discover.Discover(files)
	}
	now := time.Now()
	elapsed := now.Sub(start).Round(10 * time.Millisecond)
	p.mu.Lock()
	for _, file := range files {
		delete(p.pending, file)
	}
	if err != nil {
		// Not resolved: the next trigger past the delay looks them up again,
		// and so does any change to a build input.
		for _, file := range files {
			delay := p.RetryDelay
			if previous := p.failed[file]; previous != nil {
				delay = min(previous.delay*2, p.MaxRetryDelay)
			}
			p.failed[file] = &failure{retry: now.Add(delay), delay: delay}
		}
		if replace {
			p.rediscover = true
		}
		p.mu.Unlock()
		p.log(logError, "could not find the units of %s: %v", strings.Join(files, " "), err)
		return nil
	}
	for _, file := range files {
		p.resolved[file] = true
		delete(p.failed, file)
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
		return nil
	}
	if !changed {
		return nil
	}
	// In flight before the server hears of it, so its report cannot come
	// first.
	r := &reload{files: files, done: make(chan struct{})}
	p.mu.Lock()
	p.inFlight = r
	p.mu.Unlock()
	p.sendServer(map[string]any{
		"method": "workspace/didChangeWatchedFiles",
		"params": map[string]any{
			"changes": []any{map[string]any{"uri": pathURI(p.ConfigPath), "type": 2}},
		},
	})
	return r
}

// reloaded releases the documents of the reload in flight, if the
// notification reports the config. A report with none in flight (a
// duplicate, or Deno reloading on its own) changes nothing.
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
		r := p.inFlight
		p.inFlight = nil
		p.mu.Unlock()
		if r != nil {
			p.releasePaths(r.files)
			close(r.done)
		}
		return
	}
}
