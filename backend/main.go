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
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "../public/data", "path to the transit data directory (must contain headways.json, lines.geojson, stations.geojson)")
	corsOrigin := flag.String("cors", "*", "Access-Control-Allow-Origin value; empty disables the header")
	disruptPoll := flag.Duration("disruptions-poll", 60*time.Second, "interval between background polls of the IBB disruptions API")
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
		Handler:           NewServer(lines, disruptions, *corsOrigin).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
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
