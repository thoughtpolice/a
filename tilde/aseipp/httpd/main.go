// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	// Set up routes
	http.HandleFunc("/", handleRoot)
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/time", handleTime)

	// Get port from environment or default to 8080
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	addr := ":" + port
	log.Printf("Starting HTTP server on %s", addr)

	// Start the server
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "Hello, World!\n")
	fmt.Fprintf(w, "This is a simple HTTP server written in Go.\n")
	fmt.Fprintf(w, "Method: %s\n", r.Method)
	fmt.Fprintf(w, "URL: %s\n", r.URL.Path)
	fmt.Fprintf(w, "Remote Address: %s\n", r.RemoteAddr)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status": "ok", "timestamp": "%s"}`, time.Now().UTC().Format(time.RFC3339))
}

func handleTime(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	fmt.Fprintf(w, "Current time: %s\n", now.Format(time.RFC3339))
	fmt.Fprintf(w, "Unix timestamp: %d\n", now.Unix())
}
