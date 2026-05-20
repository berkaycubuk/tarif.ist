package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPolylineLengthEmpty(t *testing.T) {
	var pl polyline
	if pl.length() != 0 {
		t.Fatalf("empty polyline length = %v, want 0", pl.length())
	}
}

func TestPolylineLengthNonEmpty(t *testing.T) {
	pl := makePolyline([]point{{lng: 0, lat: 0}, {lng: 0, lat: 1}})
	if !approxEqual(pl.length(), metresPerDegLat, 1) {
		t.Fatalf("length = %v, want ~%v", pl.length(), metresPerDegLat)
	}
}

func TestMakePolylineEmpty(t *testing.T) {
	pl := makePolyline(nil)
	if len(pl.pts) != 0 || len(pl.cum) != 0 {
		t.Fatalf("expected empty polyline, got %+v", pl)
	}
}

func TestBuildTripScheduleTooFewStations(t *testing.T) {
	stns := []station{{Name: "only"}}
	if got := buildTripSchedule(stns, 600); got != nil {
		t.Fatalf("expected nil for 1 station, got %v", got)
	}
}

func TestBuildTripScheduleZeroDuration(t *testing.T) {
	stns := []station{{Name: "a"}, {Name: "b", Lat: 41, Lng: 29}}
	if got := buildTripSchedule(stns, 0); got != nil {
		t.Fatalf("expected nil for 0 duration, got %v", got)
	}
}

func TestBuildTripScheduleZeroDistance(t *testing.T) {
	stns := []station{
		{Name: "a", Lat: 41, Lng: 29},
		{Name: "b", Lat: 41, Lng: 29},
	}
	if got := buildTripSchedule(stns, 600); got != nil {
		t.Fatalf("expected nil for zero distance, got %v", got)
	}
}

func TestBuildTripScheduleTwoStations(t *testing.T) {
	stns := []station{
		{Name: "a", Lat: 41.0, Lng: 29.0},
		{Name: "b", Lat: 41.0, Lng: 29.1},
	}
	segs := buildTripSchedule(stns, 600)
	if len(segs) != 1 {
		t.Fatalf("expected 1 segment for 2 stations, got %d", len(segs))
	}
	if segs[0].startSec != 0 || segs[0].endSec != 600 {
		t.Fatalf("seg = %+v, want 0..600", segs[0])
	}
	if segs[0].startIdx != 0 || segs[0].endIdx != 1 {
		t.Fatalf("seg indices = %+v", segs[0])
	}
}

func TestBuildTripScheduleThreeStationsWithDwell(t *testing.T) {
	stns := []station{
		{Name: "a", Lat: 41.0, Lng: 29.0},
		{Name: "b", Lat: 41.0, Lng: 29.1},
		{Name: "c", Lat: 41.0, Lng: 29.2},
	}
	segs := buildTripSchedule(stns, 600)
	// Should have: travel a→b, dwell at b, travel b→c.
	if len(segs) != 3 {
		t.Fatalf("expected 3 segments, got %d (%+v)", len(segs), segs)
	}
	if segs[0].startIdx != 0 || segs[0].endIdx != 1 {
		t.Fatalf("seg0 = %+v", segs[0])
	}
	if segs[1].startIdx != 1 || segs[1].endIdx != 1 {
		t.Fatalf("dwell seg = %+v", segs[1])
	}
	if segs[2].startIdx != 1 || segs[2].endIdx != 2 {
		t.Fatalf("seg2 = %+v", segs[2])
	}
	// Dwell length should be 20s.
	dwellLen := segs[1].endSec - segs[1].startSec
	if !approxEqual(dwellLen, dwellPerStationSec, 1e-6) {
		t.Fatalf("dwell = %v, want %v", dwellLen, dwellPerStationSec)
	}
}

func TestBuildTripScheduleDwellClampedShortTrip(t *testing.T) {
	// Many stations + short trip → dwell share should be clamped to half.
	stns := []station{
		{Name: "a", Lat: 41.0, Lng: 29.00},
		{Name: "b", Lat: 41.0, Lng: 29.01},
		{Name: "c", Lat: 41.0, Lng: 29.02},
		{Name: "d", Lat: 41.0, Lng: 29.03},
		{Name: "e", Lat: 41.0, Lng: 29.04},
	}
	tripDur := 10.0 // very short, 3 intermediates × 20s = 60s would exceed half
	segs := buildTripSchedule(stns, tripDur)
	totalDwell := 0.0
	for _, s := range segs {
		if s.startIdx == s.endIdx {
			totalDwell += s.endSec - s.startSec
		}
	}
	if totalDwell > tripDur*maxDwellShareOfTrip+1e-6 {
		t.Fatalf("dwell %v exceeds half of trip %v", totalDwell, tripDur)
	}
}

func TestSegmentAtTripTimeEmpty(t *testing.T) {
	l := &Line{}
	seg, frac := l.segmentAtTripTime(10)
	if seg != (tripSegment{}) || frac != 0 {
		t.Fatalf("expected zero seg + frac, got %+v %v", seg, frac)
	}
}

func TestSegmentAtTripTimeBoundaries(t *testing.T) {
	stns := []station{
		{Name: "a", Lat: 41.0, Lng: 29.0},
		{Name: "b", Lat: 41.0, Lng: 29.1},
		{Name: "c", Lat: 41.0, Lng: 29.2},
	}
	l := &Line{
		stations: stns,
		schedule: buildTripSchedule(stns, 600),
	}
	// Before start → first seg, frac 0.
	seg, frac := l.segmentAtTripTime(-1)
	if seg.startIdx != 0 || frac != 0 {
		t.Fatalf("before start: %+v %v", seg, frac)
	}
	// After end → last seg, frac 1.
	seg, frac = l.segmentAtTripTime(10000)
	last := l.schedule[len(l.schedule)-1]
	if seg != last || frac != 1 {
		t.Fatalf("after end: %+v %v, want %+v 1", seg, frac, last)
	}
	// Inside a travel segment.
	seg, frac = l.segmentAtTripTime(l.schedule[0].endSec / 2)
	if seg.startIdx != 0 || seg.endIdx != 1 {
		t.Fatalf("mid first seg: %+v", seg)
	}
	if frac <= 0 || frac >= 1 {
		t.Fatalf("frac = %v, want in (0,1)", frac)
	}
	// Inside dwell segment (startIdx == endIdx).
	dwellSeg := l.schedule[1]
	mid := (dwellSeg.startSec + dwellSeg.endSec) / 2
	seg, frac = l.segmentAtTripTime(mid)
	if seg.startIdx != seg.endIdx {
		t.Fatalf("expected dwell, got %+v", seg)
	}
	if frac != 0 {
		t.Fatalf("dwell frac = %v, want 0", frac)
	}
}

func TestSegmentAtTripTimeZeroSpan(t *testing.T) {
	// A schedule entry with span 0 hits the span > 0 guard.
	l := &Line{schedule: []tripSegment{
		{startSec: 0, endSec: 0, startIdx: 0, endIdx: 1},
		{startSec: 0, endSec: 10, startIdx: 1, endIdx: 2},
	}}
	// tripT=-0.0001 hits the "tripT < s.endSec" branch with span=0.
	// Actually we want tripT inside zero-span. Since tripT<=0 returns first seg,
	// we cover the span==0 branch via a non-dwell zero-span segment in the loop.
	// Easier: schedule with a single zero-span travel segment.
	l = &Line{schedule: []tripSegment{
		{startSec: 0, endSec: 0, startIdx: 0, endIdx: 1},
		{startSec: 0, endSec: 5, startIdx: 1, endIdx: 2},
	}}
	// Force entry into the loop with tripT > 0.
	seg, frac := l.segmentAtTripTime(2)
	if seg.endIdx != 2 {
		t.Fatalf("got %+v", seg)
	}
	_ = frac
}

func TestReverseSegmentAndPolyline(t *testing.T) {
	pts := []point{{lng: 1}, {lng: 2}, {lng: 3}}
	r := reverseSegment(pts)
	if r[0].lng != 3 || r[1].lng != 2 || r[2].lng != 1 {
		t.Fatalf("reverseSegment = %+v", r)
	}
	pl := makePolyline(pts)
	rpl := reversePolyline(pl)
	if rpl.pts[0].lng != 3 || rpl.pts[2].lng != 1 {
		t.Fatalf("reversePolyline = %+v", rpl.pts)
	}
}

func TestSegmentLength(t *testing.T) {
	pts := []point{
		{lng: 0, lat: 0},
		{lng: 0, lat: 1},
		{lng: 0, lat: 2},
	}
	got := segmentLength(pts)
	want := 2 * metresPerDegLat
	if !approxEqual(got, want, 1) {
		t.Fatalf("segmentLength = %v, want ~%v", got, want)
	}
}

func TestCoordsToPoints(t *testing.T) {
	raw := [][2]float64{{1, 2}, {3, 4}}
	pts := coordsToPoints(raw)
	if len(pts) != 2 || pts[0] != (point{lng: 1, lat: 2}) || pts[1] != (point{lng: 3, lat: 4}) {
		t.Fatalf("coordsToPoints = %+v", pts)
	}
}

func TestDecodeLineGeometryLineString(t *testing.T) {
	g := geoGeometry{
		Type:        "LineString",
		Coordinates: json.RawMessage(`[[0,0],[1,1]]`),
	}
	segs, err := decodeLineGeometry(g)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 1 || len(segs[0]) != 2 {
		t.Fatalf("segs = %+v", segs)
	}
}

func TestDecodeLineGeometryLineStringBad(t *testing.T) {
	g := geoGeometry{Type: "LineString", Coordinates: json.RawMessage(`"x"`)}
	if _, err := decodeLineGeometry(g); err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodeLineGeometryMultiLineString(t *testing.T) {
	g := geoGeometry{
		Type:        "MultiLineString",
		Coordinates: json.RawMessage(`[[[0,0],[1,1]],[[2,2],[3,3]]]`),
	}
	segs, err := decodeLineGeometry(g)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 {
		t.Fatalf("segs = %+v", segs)
	}
}

func TestDecodeLineGeometryMultiLineStringBad(t *testing.T) {
	g := geoGeometry{Type: "MultiLineString", Coordinates: json.RawMessage(`"x"`)}
	if _, err := decodeLineGeometry(g); err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodeLineGeometryUnsupported(t *testing.T) {
	g := geoGeometry{Type: "Polygon"}
	if _, err := decodeLineGeometry(g); err == nil {
		t.Fatal("expected error")
	}
}

func TestStitchEmpty(t *testing.T) {
	pl := stitch(nil)
	if len(pl.pts) != 0 {
		t.Fatalf("expected empty, got %+v", pl)
	}
}

func TestStitchSingleSegment(t *testing.T) {
	segs := [][]point{{{lng: 0, lat: 0}, {lng: 0, lat: 1}}}
	pl := stitch(segs)
	if len(pl.pts) != 2 {
		t.Fatalf("pts = %v", pl.pts)
	}
}

func TestStitchJoinTailToHead(t *testing.T) {
	a := []point{{lng: 0, lat: 0}, {lng: 0, lat: 0.001}}
	b := []point{{lng: 0, lat: 0.001}, {lng: 0, lat: 0.002}}
	pl := stitch([][]point{a, b})
	if len(pl.pts) != 3 {
		t.Fatalf("pts = %+v", pl.pts)
	}
}

func TestStitchJoinReversed(t *testing.T) {
	a := []point{{lng: 0, lat: 0}, {lng: 0, lat: 0.001}}
	b := []point{{lng: 0, lat: 0.002}, {lng: 0, lat: 0.001}}
	pl := stitch([][]point{a, b})
	if len(pl.pts) != 3 {
		t.Fatalf("pts = %+v", pl.pts)
	}
}

func TestStitchPrepend(t *testing.T) {
	// Long seed segment, plus a shorter segment whose end connects to seed head.
	seed := []point{{lng: 0, lat: 0.0}, {lng: 0, lat: 0.01}, {lng: 0, lat: 0.02}}
	other := []point{{lng: 0, lat: -0.001}, {lng: 0, lat: 0.0}}
	pl := stitch([][]point{seed, other})
	if len(pl.pts) < 4 {
		t.Fatalf("expected prepend, got %+v", pl.pts)
	}
	// First point should be other[0].
	if pl.pts[0].lat != -0.001 {
		t.Fatalf("first = %+v", pl.pts[0])
	}
}

func TestStitchPrependReversed(t *testing.T) {
	seed := []point{{lng: 0, lat: 0.0}, {lng: 0, lat: 0.01}, {lng: 0, lat: 0.02}}
	// other[0] = 0.0 (matches head); but to hit bestPrepend && bestReverse,
	// we need head==other_end_reversed. Make other[0]=0.0, other[1]=-0.001.
	// head=other[0]=0.0 → no reverse needed. To force reverse: head=other[end].
	// So make other={-0.001, 0.0}; that gives bestPrepend without reverse.
	// For prepend+reverse, head matches other[0] AND we want reverse to be used.
	// That happens when head==other[0]: stitch picks "head→other[0]" which is
	// prepend=true, reverse=true.
	other := []point{{lng: 0, lat: 0.0}, {lng: 0, lat: -0.001}}
	pl := stitch([][]point{seed, other})
	if len(pl.pts) < 4 {
		t.Fatalf("pts = %+v", pl.pts)
	}
	if pl.pts[0].lat != -0.001 {
		t.Fatalf("first = %+v (want -0.001)", pl.pts[0])
	}
}

func TestStitchSkipShortSegment(t *testing.T) {
	// One single-point "segment" should be skipped.
	a := []point{{lng: 0, lat: 0}, {lng: 0, lat: 0.001}}
	b := []point{{lng: 0, lat: 0.001}} // len < 2
	pl := stitch([][]point{a, b})
	if len(pl.pts) != 2 {
		t.Fatalf("expected len 2, got %+v", pl.pts)
	}
}

func TestStitchNoMatchBreaks(t *testing.T) {
	a := []point{{lng: 0, lat: 0}, {lng: 0, lat: 0.001}}
	b := []point{{lng: 50, lat: 50}, {lng: 50, lat: 50.001}}
	pl := stitch([][]point{a, b})
	// Only one segment gets used (the seed = longest tied → first).
	if len(pl.pts) != 2 {
		t.Fatalf("expected len 2, got %+v", pl.pts)
	}
}

func TestProjectAndOrderStations(t *testing.T) {
	pl := makePolyline([]point{
		{lng: 0, lat: 0},
		{lng: 0, lat: 0.1},
	})
	stns := []station{
		{Name: "mid", Lat: 0.05, Lng: 0},
		{Name: "start", Lat: 0, Lng: 0},
		{Name: "end", Lat: 0.1, Lng: 0},
	}
	ordered := projectAndOrderStations(stns, pl)
	if len(ordered) != 3 {
		t.Fatalf("got %d stations", len(ordered))
	}
	if ordered[0].Name != "start" || ordered[1].Name != "mid" || ordered[2].Name != "end" {
		t.Fatalf("order = %v", ordered)
	}
}

func TestProjectAndOrderStationsDedup(t *testing.T) {
	pl := makePolyline([]point{
		{lng: 0, lat: 0},
		{lng: 0, lat: 0.01},
	})
	stns := []station{
		{Name: "a", Lat: 0, Lng: 0},
		{Name: "b", Lat: 0, Lng: 0}, // same projection → dropped
	}
	ordered := projectAndOrderStations(stns, pl)
	if len(ordered) != 1 {
		t.Fatalf("expected 1 after dedup, got %d", len(ordered))
	}
}

func TestProjectStation(t *testing.T) {
	pl := makePolyline([]point{
		{lng: 0, lat: 0},
		{lng: 0, lat: 1},
	})
	d := projectStation(station{Lat: 0.5, Lng: 0}, pl)
	want := 0.5 * metresPerDegLat
	if !approxEqual(d, want, 1) {
		t.Fatalf("projectStation = %v, want ~%v", d, want)
	}
}

// writeDataDir writes the standard trio of files into a temp dir for LoadLines.
func writeDataDir(t *testing.T, headways any, lines any, stations any) string {
	t.Helper()
	dir := t.TempDir()
	for _, f := range []struct {
		name string
		val  any
	}{
		{"headways.json", headways},
		{"lines.geojson", lines},
		{"stations.geojson", stations},
	} {
		b, err := json.Marshal(f.val)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, f.name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func makeSimpleFC() (any, any, any) {
	headways := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	lines := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1", "shortName": "M1 Line", "kind": "metro"},
				"geometry": map[string]any{
					"type":        "LineString",
					"coordinates": [][2]float64{{29.0, 41.0}, {29.0, 41.05}, {29.0, 41.1}},
				},
			},
		},
	}
	stations := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1", "name": "A"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.0}},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "B"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.05}},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "C"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.1}},
			},
		},
	}
	return headways, lines, stations
}

func TestLoadLinesSuccess(t *testing.T) {
	h, l, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d lines", len(out))
	}
	line := out["M1"]
	if line.Name != "M1 Line" || line.Kind != "metro" {
		t.Fatalf("line = %+v", line)
	}
	if len(line.stations) != 3 {
		t.Fatalf("stations = %d", len(line.stations))
	}
}

func TestLoadLinesReversedOrientation(t *testing.T) {
	// Force first-station distAlong > last by reversing the line geometry order.
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	l := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1"},
				"geometry": map[string]any{
					"type":        "LineString",
					"coordinates": [][2]float64{{29.0, 41.1}, {29.0, 41.05}, {29.0, 41.0}},
				},
			},
		},
	}
	s := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1", "name": "A"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.0}},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "C"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.1}},
			},
		},
	}
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	line := out["M1"]
	if line.stations[0].distAlong > line.stations[len(line.stations)-1].distAlong {
		t.Fatalf("orientation not fixed: %v", line.stations)
	}
}

func TestLoadLinesTripClamp(t *testing.T) {
	// trainCount * headway / 2 < tripDurationSec → should clamp.
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 60, TripDurationSec: 9999, TrainCount: 2},
	}
	_, l, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	line := out["M1"]
	if len(line.schedule) == 0 {
		t.Fatalf("expected schedule")
	}
	last := line.schedule[len(line.schedule)-1]
	half := float64(2) * 60.0 / 2
	if last.endSec > half+1 {
		t.Fatalf("schedule end %v exceeds half %v", last.endSec, half)
	}
}

func TestLoadLinesMissingHeadway(t *testing.T) {
	h := map[string]headwayInfo{}
	_, l, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Fatalf("expected 0, got %d", len(out))
	}
}

func TestLoadLinesEmptyLineCode(t *testing.T) {
	// Feature without lineCode should be skipped silently.
	h := map[string]headwayInfo{}
	l := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{},
				"geometry": map[string]any{
					"type":        "LineString",
					"coordinates": [][2]float64{{0, 0}, {1, 1}},
				},
			},
		},
	}
	s := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{0, 0}},
			},
		},
	}
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Fatalf("expected 0, got %d", len(out))
	}
}

func TestLoadLinesStationNonPointSkipped(t *testing.T) {
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	_, l, _ := makeSimpleFC()
	s := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1", "name": "wrong-geom"},
				"geometry":   map[string]any{"type": "LineString", "coordinates": [][2]float64{{0, 0}}},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "bad-coords"},
				"geometry":   map[string]any{"type": "Point", "coordinates": "garbage"},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "A"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.0}},
			},
			{
				"properties": map[string]any{"lineCode": "M1", "name": "B"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.05}},
			},
		},
	}
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if line, ok := out["M1"]; !ok || len(line.stations) != 2 {
		t.Fatalf("unexpected stations: %+v", out)
	}
}

func TestLoadLinesTooFewStations(t *testing.T) {
	// Only one station projects to the polyline → line dropped.
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	_, l, _ := makeSimpleFC()
	s := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1", "name": "A"},
				"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{29.0, 41.0}},
			},
		},
	}
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out["M1"]; ok {
		t.Fatalf("expected line dropped: %+v", out)
	}
}

func TestLoadLinesBadGeometry(t *testing.T) {
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	l := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1"},
				"geometry":   map[string]any{"type": "Polygon", "coordinates": [][]float64{}},
			},
		},
	}
	_, _, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)
	if _, err := LoadLines(dir); err == nil {
		t.Fatal("expected error from bad geometry")
	}
}

func TestLoadLinesEmptyPolyline(t *testing.T) {
	// Geometry with single point so polyline length is 0; line dropped.
	h := map[string]headwayInfo{
		"M1": {HeadwaySec: 240, TripDurationSec: 1800, TrainCount: 8},
	}
	l := map[string]any{
		"features": []map[string]any{
			{
				"properties": map[string]any{"lineCode": "M1"},
				"geometry": map[string]any{
					"type":        "LineString",
					"coordinates": [][2]float64{{29.0, 41.0}},
				},
			},
		},
	}
	_, _, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)
	out, err := LoadLines(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out["M1"]; ok {
		t.Fatalf("expected line dropped: %+v", out)
	}
}

func TestLoadLinesMissingFiles(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadLines(dir); err == nil {
		t.Fatal("expected error for missing files")
	}
	// Provide headways only.
	if err := os.WriteFile(filepath.Join(dir, "headways.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadLines(dir); err == nil {
		t.Fatal("expected error for missing lines.geojson")
	}
	if err := os.WriteFile(filepath.Join(dir, "lines.geojson"), []byte(`{"features":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadLines(dir); err == nil {
		t.Fatal("expected error for missing stations.geojson")
	}
}

func TestReadJSON(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.json")
	if err := os.WriteFile(p, []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	var v map[string]int
	if err := readJSON(p, &v); err != nil {
		t.Fatal(err)
	}
	if v["a"] != 1 {
		t.Fatalf("v = %+v", v)
	}
	if err := readJSON(filepath.Join(dir, "missing.json"), &v); err == nil {
		t.Fatal("expected error")
	}
}
