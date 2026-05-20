package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// Server holds the loaded line catalog and any background services that drive
// dynamic endpoints. It's safe for concurrent use: Line data is immutable
// after LoadLines, positions are derived per-request from immutable schedule,
// and DisruptionsService synchronises its own cache internally.
type Server struct {
	lines       map[string]*Line
	disruptions *DisruptionsService
	corsOrigin  string
}

func NewServer(lines map[string]*Line, disruptions *DisruptionsService, corsOrigin string) *Server {
	return &Server{lines: lines, disruptions: disruptions, corsOrigin: corsOrigin}
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /v1/lines", s.handleLines)
	mux.HandleFunc("GET /v1/lines/geometry", s.handleLinesGeometry)
	mux.HandleFunc("GET /v1/positions", s.handlePositions)
	mux.HandleFunc("GET /v1/positions/{line}", s.handlePositionsForLine)
	mux.HandleFunc("GET /v1/disruptions", s.handleDisruptions)
	return mux
}

// Handler returns the routes wrapped in CORS + cache-control middleware.
func (s *Server) Handler() http.Handler {
	return s.withMiddleware(s.Routes())
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.corsOrigin != "" {
			w.Header().Set("Access-Control-Allow-Origin", s.corsOrigin)
			w.Header().Set("Vary", "Origin")
		}
		// Positions move continuously, but a 1-second cache absorbs bursts
		// without making the data feel stale. Clients should poll on a 2-5s
		// cadence regardless.
		w.Header().Set("Cache-Control", "public, max-age=1")
		next.ServeHTTP(w, r)
	})
}

// --- handlers ---------------------------------------------------------------

type disruptionsResponse struct {
	FetchedAt int64            `json:"fetchedAt"`
	Items     []DisruptionItem `json:"items"`
}

// handleDisruptions serves the cached, adapted IBB service-status snapshot.
// The polling goroutine refreshes the cache in the background, so this
// handler is just a fast read of an in-memory slice — no upstream call.
func (s *Server) handleDisruptions(w http.ResponseWriter, _ *http.Request) {
	if s.disruptions == nil {
		writeJSON(w, http.StatusOK, disruptionsResponse{Items: []DisruptionItem{}})
		return
	}
	items, fetchedAt, _ := s.disruptions.Snapshot()
	if items == nil {
		items = []DisruptionItem{}
	}
	// Zero time.Time is January 1, year 1 — Unix() returns a huge negative
	// number that looks broken to clients. Report 0 until the first successful
	// fetch lands so clients can detect "not ready" cleanly.
	var fetchedUnix int64
	if !fetchedAt.IsZero() {
		fetchedUnix = fetchedAt.Unix()
	}
	writeJSON(w, http.StatusOK, disruptionsResponse{
		FetchedAt: fetchedUnix,
		Items:     items,
	})
}

type lineGeometry struct {
	Code        string       `json:"code"`
	Coordinates [][2]float64 `json:"coordinates"`
}

// handleLinesGeometry returns one cleaned [lng, lat] polyline per rail line.
// The geometry is precomputed at load time; the handler just serves the cached
// slices. Clients render the result directly without further processing.
func (s *Server) handleLinesGeometry(w http.ResponseWriter, _ *http.Request) {
	out := make([]lineGeometry, 0, len(s.lines))
	for code, l := range s.lines {
		if len(l.renderedPath) < 2 {
			continue
		}
		out = append(out, lineGeometry{Code: code, Coordinates: l.renderedPath})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"lines":  len(s.lines),
	})
}

type lineSummary struct {
	Code            string         `json:"code"`
	Name            string         `json:"name"`
	Kind            string         `json:"kind"`
	StationCount    int            `json:"stationCount"`
	HeadwaySec      float64        `json:"headwaySec"`
	TripDurationSec float64        `json:"tripDurationSec"`
	TrainCount      int            `json:"trainCount"`
	LengthMetres    float64        `json:"lengthMetres"`
	Stations        []stationView  `json:"stations,omitempty"`
}

type stationView struct {
	Name      string  `json:"name"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	DistAlong float64 `json:"distAlongMetres"`
}

func (s *Server) handleLines(w http.ResponseWriter, r *http.Request) {
	includeStations := r.URL.Query().Get("stations") == "1"
	out := make([]lineSummary, 0, len(s.lines))
	for _, l := range s.lines {
		summary := lineSummary{
			Code:            l.Code,
			Name:            l.Name,
			Kind:            l.Kind,
			StationCount:    len(l.stations),
			HeadwaySec:      l.headwaySec,
			TripDurationSec: l.tripDurationSec,
			TrainCount:      l.trainCount,
			LengthMetres:    l.pl.length(),
		}
		if includeStations {
			summary.Stations = stationViews(l.stations)
		}
		out = append(out, summary)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	writeJSON(w, http.StatusOK, out)
}

func stationViews(stns []station) []stationView {
	out := make([]stationView, len(stns))
	for i, s := range stns {
		out[i] = stationView{
			Name: s.Name, Lat: s.Lat, Lng: s.Lng, DistAlong: s.distAlong,
		}
	}
	return out
}

type positionsResponse struct {
	GeneratedAt int64                       `json:"generatedAt"`
	Lines       map[string][]TrainPosition  `json:"lines"`
}

func (s *Server) handlePositions(w http.ResponseWriter, r *http.Request) {
	t := requestedTime(r)
	resp := positionsResponse{
		GeneratedAt: int64(t),
		Lines:       make(map[string][]TrainPosition, len(s.lines)),
	}
	for code, l := range s.lines {
		resp.Lines[code] = l.PositionsFor(t)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handlePositionsForLine(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("line")
	l, ok := s.lines[code]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown line " + code})
		return
	}
	t := requestedTime(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"generatedAt": int64(t),
		"line":        code,
		"trains":      l.PositionsFor(t),
	})
}

// requestedTime lets clients pass ?at=<unix-seconds> for deterministic replay
// (tests, debugging, scrubbing through the day). Defaults to server time.
func requestedTime(r *http.Request) float64 {
	if raw := r.URL.Query().Get("at"); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			return v
		}
	}
	return float64(time.Now().Unix())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
