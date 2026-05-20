package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestServer() *Server {
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.0, distAlong: 0},
		{Name: "B", Lat: 41.05, Lng: 29.0, distAlong: 5000},
		{Name: "C", Lat: 41.1, Lng: 29.0, distAlong: 10000},
	}
	tripDur := 600.0
	pl := makePolyline([]point{
		{lng: 29.0, lat: 41.0},
		{lng: 29.0, lat: 41.1},
	})
	line := &Line{
		Code:            "M1",
		Name:            "M1 Line",
		Kind:            "metro",
		stations:        stns,
		pl:              pl,
		headwaySec:      300,
		tripDurationSec: tripDur,
		trainCount:      4,
		schedule:        buildTripSchedule(stns, tripDur),
		renderedPath:    [][2]float64{{29.0, 41.0}, {29.0, 41.05}, {29.0, 41.1}},
	}
	disrupt := NewDisruptionsService(time.Minute)
	return NewServer(map[string]*Line{"M1": line}, disrupt, "*")
}

func doRequest(t *testing.T, s *Server, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestHandleHealth(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/healthz")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %+v", body)
	}
	if body["lines"].(float64) != 1 {
		t.Fatalf("lines = %v", body["lines"])
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("CORS missing")
	}
	if rec.Header().Get("Cache-Control") == "" {
		t.Fatalf("Cache-Control missing")
	}
}

func TestHandleLines(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/lines")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var out []lineSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Code != "M1" || out[0].StationCount != 3 {
		t.Fatalf("out = %+v", out)
	}
	if out[0].Stations != nil {
		t.Fatalf("expected no stations without ?stations=1")
	}
}

func TestHandleLinesWithStations(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/lines?stations=1")
	var out []lineSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out[0].Stations) != 3 {
		t.Fatalf("stations: %+v", out[0].Stations)
	}
	if out[0].Stations[0].Name != "A" {
		t.Fatalf("first station: %+v", out[0].Stations[0])
	}
}

func TestHandleLinesGeometry(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/lines/geometry")
	var out []lineGeometry
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Code != "M1" || len(out[0].Coordinates) != 3 {
		t.Fatalf("out = %+v", out)
	}
}

func TestHandleLinesGeometryShortPathSkipped(t *testing.T) {
	s := newTestServer()
	// Tamper: rendered path with <2 points should be skipped.
	s.lines["M1"].renderedPath = [][2]float64{{0, 0}}
	rec := doRequest(t, s, "GET", "/v1/lines/geometry")
	var out []lineGeometry
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Fatalf("expected empty, got %+v", out)
	}
}

func TestHandlePositions(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/positions?at=1000000")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var out positionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.GeneratedAt != 1000000 {
		t.Fatalf("generatedAt = %v", out.GeneratedAt)
	}
	if len(out.Lines["M1"]) != 4 {
		t.Fatalf("trains = %d", len(out.Lines["M1"]))
	}
}

func TestHandlePositionsForLine(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/positions/M1?at=1000000")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["line"] != "M1" {
		t.Fatalf("line = %v", out["line"])
	}
	if out["generatedAt"].(float64) != 1000000 {
		t.Fatalf("generatedAt = %v", out["generatedAt"])
	}
}

func TestHandlePositionsForLineUnknown(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/positions/UNKNOWN")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestRequestedTimeDefault(t *testing.T) {
	req := httptest.NewRequest("GET", "/v1/positions", nil)
	before := float64(time.Now().Unix())
	got := requestedTime(req)
	if got < before-1 {
		t.Fatalf("got %v, before %v", got, before)
	}
}

func TestRequestedTimeBadValue(t *testing.T) {
	req := httptest.NewRequest("GET", "/v1/positions?at=garbage", nil)
	before := float64(time.Now().Unix())
	got := requestedTime(req)
	if got < before-1 {
		t.Fatalf("got %v", got)
	}
}

func TestHandleDisruptionsNoService(t *testing.T) {
	s := NewServer(map[string]*Line{}, nil, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/disruptions", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var out disruptionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.FetchedAt != 0 || len(out.Items) != 0 {
		t.Fatalf("out = %+v", out)
	}
	// No CORS header when corsOrigin is empty.
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unexpected CORS header")
	}
}

func TestHandleDisruptionsEmpty(t *testing.T) {
	s := newTestServer()
	rec := doRequest(t, s, "GET", "/v1/disruptions")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var out disruptionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.FetchedAt != 0 {
		t.Fatalf("fetchedAt = %v", out.FetchedAt)
	}
	if out.Items == nil || len(out.Items) != 0 {
		t.Fatalf("items = %+v (must be empty slice, not null)", out.Items)
	}
}

func TestHandleDisruptionsWithItems(t *testing.T) {
	s := newTestServer()
	now := time.Now().UTC()
	s.disruptions.mu.Lock()
	s.disruptions.items = []DisruptionItem{
		{ID: "x", LineCode: "M1", Severity: "warning", Type: "delay", Title: "t", Description: "d"},
	}
	s.disruptions.fetchedAt = now
	s.disruptions.mu.Unlock()

	rec := doRequest(t, s, "GET", "/v1/disruptions")
	var out disruptionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.FetchedAt != now.Unix() {
		t.Fatalf("fetchedAt = %v, want %v", out.FetchedAt, now.Unix())
	}
	if len(out.Items) != 1 {
		t.Fatalf("items: %+v", out.Items)
	}
}

func TestStationViews(t *testing.T) {
	stns := []station{{Name: "A", Lat: 1, Lng: 2, distAlong: 3}}
	got := stationViews(stns)
	if got[0].Name != "A" || got[0].Lat != 1 || got[0].Lng != 2 || got[0].DistAlong != 3 {
		t.Fatalf("got %+v", got)
	}
}

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, 201, map[string]string{"hello": "<world>"})
	if rec.Code != 201 {
		t.Fatalf("code = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<world>") {
		t.Fatalf("EscapeHTML should be off; body=%q", rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", rec.Header().Get("Content-Type"))
	}
}
