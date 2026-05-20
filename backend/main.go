package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", envOr("ADDR", ":8080"), "listen address (env ADDR)")
	dataDir := flag.String("data", envOr("DATA_DIR", "../public/data"), "path to the transit data directory (env DATA_DIR)")
	corsOrigin := flag.String("cors", envOr("CORS_ORIGIN", "*"), "Access-Control-Allow-Origin value; empty disables the header (env CORS_ORIGIN)")
	disruptPoll := flag.Duration("disruptions-poll", envDurationOr("DISRUPTIONS_POLL", 60*time.Second), "interval between background polls of the IBB disruptions API (env DISRUPTIONS_POLL)")
	flag.Parse()

	lines, err := LoadLines(*dataDir)
	if err != nil {
		log.Fatalf("load lines: %v", err)
	}
	if len(lines) == 0 {
		log.Fatalf("no lines loaded from %s", *dataDir)
	}
	log.Printf("loaded %d lines from %s", len(lines), *dataDir)

	// Graceful shutdown on SIGINT/SIGTERM. Disruptions polling lives on this
	// context so the goroutine winds down with the rest of the server.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	disruptions := NewDisruptionsService(*disruptPoll)
	disruptions.Start(ctx)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           withAccessLog(NewServer(lines, disruptions, *corsOrigin).Handler()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDurationOr(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Printf("invalid duration %s=%q, using default %s", key, v, def)
		return def
	}
	return d
}

// withAccessLog wraps h with a single-line request logger. Capturing the
// status code requires a small ResponseWriter shim — the stdlib's writer
// doesn't expose what code was sent.
func withAccessLog(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.RequestURI(), rec.status, time.Since(start).Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}
