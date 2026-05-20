package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
)

// polyline is an ordered list of vertices plus a parallel array of cumulative
// distances (metres). cum[0]=0 and cum[len-1] = total length. The geometry
// itself is no longer used for positioning (trains interpolate between station
// coords instead), but we keep the length so /v1/lines can report it and so
// projections during line build still work.
type polyline struct {
	pts []point
	cum []float64
}

func (pl *polyline) length() float64 {
	if len(pl.cum) == 0 {
		return 0
	}
	return pl.cum[len(pl.cum)-1]
}

type station struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	// distAlong is the cumulative distance (metres) from the line's start
	// vertex to the station's projection onto the polyline. Set during build.
	distAlong float64
}

// Line is the runtime model: an ordered polyline, an ordered station list,
// and the per-line frequency parameters used to drive the simulation.
type Line struct {
	Code            string
	Kind            string
	Name            string
	pl              polyline
	stations        []station
	headwaySec      float64
	tripDurationSec float64
	trainCount      int
	// schedule slices one A→B trip into alternating travel/dwell segments.
	// distAlong rises during travel segments and stays constant during dwell.
	// Built once during LoadLines.
	schedule []tripSegment
	// renderedPath is the visual polyline served to map clients, computed
	// once at load time via the polyline-vertex graph + Dijkstra so the
	// client doesn't have to wrangle the messy MultiLineString geometry.
	renderedPath [][2]float64
}

// tripSegment is one piece of an A→B trip: a [startSec, endSec] window during
// which the train moves linearly from station[startIdx] to station[endIdx].
// Dwell segments have startIdx == endIdx, so the train holds at that station.
//
// Positions are interpolated between actual station coordinates rather than
// projected onto the stitched polyline. The polyline is unreliable on lines
// where the source MultiLineString doesn't trivially join (M2 in particular),
// and visual dwell needs to land *on* the station marker the user sees on the
// map — straight-line interpolation between station lat/lng guarantees that.
type tripSegment struct {
	startSec float64
	endSec   float64
	startIdx int
	endIdx   int
}

// Per-station dwell time at intermediate stops, in seconds. Istanbul metro
// dwell is typically 20–30s; pick the lower bound so the schedule still fits
// even on the shortest lines.
const dwellPerStationSec = 20.0

// If laying down a 20s dwell at every intermediate station would consume more
// than this share of the trip, we shrink the dwell so the train still actually
// covers ground. Short lines like funiculars can't afford 20s × stations.
const maxDwellShareOfTrip = 0.5

// buildTripSchedule lays out one A→B trip as alternating travel/dwell
// segments. Travel time is distributed in proportion to the great-circle
// distance between consecutive stations, so a long gap between two stations
// takes proportionally longer to traverse than a short one.
func buildTripSchedule(stns []station, tripDur float64) []tripSegment {
	n := len(stns)
	if n < 2 || tripDur <= 0 {
		return nil
	}
	intermediate := n - 2
	totalDwell := float64(intermediate) * dwellPerStationSec
	if totalDwell > tripDur*maxDwellShareOfTrip {
		totalDwell = tripDur * maxDwellShareOfTrip
	}
	perDwell := 0.0
	if intermediate > 0 {
		perDwell = totalDwell / float64(intermediate)
	}
	totalTravel := tripDur - totalDwell

	// Inter-station distances as straight lines between the actual station
	// coords. Using these (vs polyline distance) keeps speeds realistic on
	// lines where the stitched polyline folds back on itself.
	segDists := make([]float64, n-1)
	totalDist := 0.0
	for i := 0; i < n-1; i++ {
		a := point{lng: stns[i].Lng, lat: stns[i].Lat}
		b := point{lng: stns[i+1].Lng, lat: stns[i+1].Lat}
		segDists[i] = a.distTo(b)
		totalDist += segDists[i]
	}
	if totalDist <= 0 {
		return nil
	}

	segs := make([]tripSegment, 0, 2*(n-1))
	t := 0.0
	for i := 0; i < n-1; i++ {
		travel := totalTravel * (segDists[i] / totalDist)
		segs = append(segs, tripSegment{
			startSec: t,
			endSec:   t + travel,
			startIdx: i,
			endIdx:   i + 1,
		})
		t += travel
		// Dwell at every intermediate arrival, but not at the terminus —
		// terminus dwell is handled by the cycle math (the gap between
		// tripDur and half-cycle).
		if i+1 < n-1 && perDwell > 0 {
			segs = append(segs, tripSegment{
				startSec: t,
				endSec:   t + perDwell,
				startIdx: i + 1,
				endIdx:   i + 1,
			})
			t += perDwell
		}
	}
	return segs
}

// segmentAtTripTime returns the schedule segment containing the given
// elapsed time within one A→B trip (in [0, tripDur]), plus the fraction
// (0..1) completed within that segment. The caller resolves stations and
// any positioning from there.
func (l *Line) segmentAtTripTime(tripT float64) (seg tripSegment, frac float64) {
	if len(l.schedule) == 0 {
		return tripSegment{}, 0
	}
	if tripT <= 0 {
		return l.schedule[0], 0
	}
	last := l.schedule[len(l.schedule)-1]
	if tripT >= last.endSec {
		return last, 1
	}
	// Linear scan is fine — most lines have <50 segments.
	for _, s := range l.schedule {
		if tripT < s.endSec {
			if s.startIdx == s.endIdx {
				return s, 0
			}
			span := s.endSec - s.startSec
			f := 0.0
			if span > 0 {
				f = (tripT - s.startSec) / span
			}
			return s, f
		}
	}
	return last, 1
}

// geojson schema (subset).

type featureCollection struct {
	Features []geoFeature `json:"features"`
}

type geoFeature struct {
	Geometry   geoGeometry            `json:"geometry"`
	Properties map[string]any         `json:"properties"`
}

// geoGeometry handles Point, LineString, and MultiLineString in one shape by
// keeping coordinates as a raw json.RawMessage and decoding lazily.
type geoGeometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

type headwayInfo struct {
	HeadwaySec      float64 `json:"headwaySec"`
	TripDurationSec float64 `json:"tripDurationSec"`
	TrainCount      int     `json:"trainCount"`
}

// LoadLines reads stations.geojson, lines.geojson, and headways.json from
// dataDir and produces a runtime Line for every line code that has all three.
// Lines missing headway data are dropped — without timing we can't simulate
// positions.
func LoadLines(dataDir string) (map[string]*Line, error) {
	headways := map[string]headwayInfo{}
	if err := readJSON(dataDir+"/headways.json", &headways); err != nil {
		return nil, fmt.Errorf("headways.json: %w", err)
	}

	var linesFC featureCollection
	if err := readJSON(dataDir+"/lines.geojson", &linesFC); err != nil {
		return nil, fmt.Errorf("lines.geojson: %w", err)
	}
	var stationsFC featureCollection
	if err := readJSON(dataDir+"/stations.geojson", &stationsFC); err != nil {
		return nil, fmt.Errorf("stations.geojson: %w", err)
	}

	// Group line segments and stations by lineCode.
	segsByCode := map[string][][]point{}
	nameByCode := map[string]string{}
	kindByCode := map[string]string{}
	for _, f := range linesFC.Features {
		code, _ := f.Properties["lineCode"].(string)
		if code == "" {
			continue
		}
		segs, err := decodeLineGeometry(f.Geometry)
		if err != nil {
			return nil, fmt.Errorf("line %s geometry: %w", code, err)
		}
		segsByCode[code] = append(segsByCode[code], segs...)
		if name, ok := f.Properties["shortName"].(string); ok && nameByCode[code] == "" {
			nameByCode[code] = name
		}
		if kind, ok := f.Properties["kind"].(string); ok && kindByCode[code] == "" {
			kindByCode[code] = kind
		}
	}

	stationsByCode := map[string][]station{}
	for _, f := range stationsFC.Features {
		code, _ := f.Properties["lineCode"].(string)
		if code == "" {
			continue
		}
		if f.Geometry.Type != "Point" {
			continue
		}
		var c [2]float64
		if err := json.Unmarshal(f.Geometry.Coordinates, &c); err != nil {
			continue
		}
		name, _ := f.Properties["name"].(string)
		stationsByCode[code] = append(stationsByCode[code], station{
			Name: name,
			Lng:  c[0],
			Lat:  c[1],
		})
	}

	out := map[string]*Line{}
	for code, segs := range segsByCode {
		h, ok := headways[code]
		if !ok || h.TripDurationSec <= 0 || h.HeadwaySec <= 0 || h.TrainCount <= 0 {
			continue
		}
		pl := stitch(segs)
		if len(pl.pts) < 2 || pl.length() < 1 {
			continue
		}
		stns := projectAndOrderStations(stationsByCode[code], pl)
		if len(stns) < 2 {
			continue
		}
		// Orient polyline so the first projected station has distAlong=0
		// (smaller than the last). stitch() picks an arbitrary direction;
		// without this we'd get inverted positions for some lines.
		if stns[0].distAlong > stns[len(stns)-1].distAlong {
			pl = reversePolyline(pl)
			stns = projectAndOrderStations(stationsByCode[code], pl)
		}
		// Schedule must respect the effective trip duration (clamped to the
		// half-cycle for over-frequent lines), so build it with the same
		// clamped value PositionsFor will use.
		halfCycle := float64(h.TrainCount) * h.HeadwaySec / 2
		effectiveTripDur := h.TripDurationSec
		if effectiveTripDur > halfCycle {
			effectiveTripDur = halfCycle
		}
		out[code] = &Line{
			Code:            code,
			Kind:            kindByCode[code],
			Name:            nameByCode[code],
			pl:              pl,
			stations:        stns,
			headwaySec:      h.HeadwaySec,
			tripDurationSec: h.TripDurationSec,
			trainCount:      h.TrainCount,
			schedule:        buildTripSchedule(stns, effectiveTripDur),
			renderedPath:    renderLinePath(stns, segs),
		}
	}
	return out, nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func decodeLineGeometry(g geoGeometry) ([][]point, error) {
	switch g.Type {
	case "LineString":
		var raw [][2]float64
		if err := json.Unmarshal(g.Coordinates, &raw); err != nil {
			return nil, err
		}
		return [][]point{coordsToPoints(raw)}, nil
	case "MultiLineString":
		var raw [][][2]float64
		if err := json.Unmarshal(g.Coordinates, &raw); err != nil {
			return nil, err
		}
		segs := make([][]point, 0, len(raw))
		for _, s := range raw {
			segs = append(segs, coordsToPoints(s))
		}
		return segs, nil
	default:
		return nil, fmt.Errorf("unsupported geometry %q", g.Type)
	}
}

func coordsToPoints(raw [][2]float64) []point {
	out := make([]point, len(raw))
	for i, c := range raw {
		out[i] = point{lng: c[0], lat: c[1]}
	}
	return out
}

// stitch joins a bag of polyline segments into a single ordered polyline by
// repeatedly appending the segment whose endpoint matches the current tail.
// Real-world line data is messy (branches, depot spurs, terminal loops), so
// when nothing matches we fall back to the longest remaining segment — the
// simulation only needs a reasonable spine, not a perfectly faithful track.
func stitch(segs [][]point) polyline {
	if len(segs) == 0 {
		return polyline{}
	}
	used := make([]bool, len(segs))
	// Seed with the longest segment so the spine has a meaningful direction
	// even if matching fails immediately.
	seed := 0
	bestLen := segmentLength(segs[0])
	for i := 1; i < len(segs); i++ {
		if l := segmentLength(segs[i]); l > bestLen {
			seed = i
			bestLen = l
		}
	}
	pts := append([]point{}, segs[seed]...)
	used[seed] = true

	const matchTolMetres = 25.0
	for {
		tail := pts[len(pts)-1]
		head := pts[0]
		bestIdx := -1
		bestDist := matchTolMetres
		bestPrepend := false
		bestReverse := false
		for i, s := range segs {
			if used[i] || len(s) < 2 {
				continue
			}
			if d := tail.distTo(s[0]); d < bestDist {
				bestIdx, bestDist, bestPrepend, bestReverse = i, d, false, false
			}
			if d := tail.distTo(s[len(s)-1]); d < bestDist {
				bestIdx, bestDist, bestPrepend, bestReverse = i, d, false, true
			}
			if d := head.distTo(s[len(s)-1]); d < bestDist {
				bestIdx, bestDist, bestPrepend, bestReverse = i, d, true, false
			}
			if d := head.distTo(s[0]); d < bestDist {
				bestIdx, bestDist, bestPrepend, bestReverse = i, d, true, true
			}
		}
		if bestIdx < 0 {
			break
		}
		s := segs[bestIdx]
		if bestReverse {
			s = reverseSegment(s)
		}
		if bestPrepend {
			// Drop the duplicate join vertex.
			pts = append(append([]point{}, s[:len(s)-1]...), pts...)
		} else {
			pts = append(pts, s[1:]...)
		}
		used[bestIdx] = true
	}

	return makePolyline(pts)
}

func segmentLength(s []point) float64 {
	total := 0.0
	for i := 1; i < len(s); i++ {
		total += s[i-1].distTo(s[i])
	}
	return total
}

func reverseSegment(s []point) []point {
	out := make([]point, len(s))
	for i, p := range s {
		out[len(s)-1-i] = p
	}
	return out
}

func reversePolyline(pl polyline) polyline {
	return makePolyline(reverseSegment(pl.pts))
}

func makePolyline(pts []point) polyline {
	if len(pts) == 0 {
		return polyline{}
	}
	cum := make([]float64, len(pts))
	for i := 1; i < len(pts); i++ {
		cum[i] = cum[i-1] + pts[i-1].distTo(pts[i])
	}
	return polyline{pts: pts, cum: cum}
}

// Stations whose projections land within this many metres of each other are
// collapsed into a single stop. This is a defence against (a) duplicate
// entries in the source geojson and (b) polyline stitching that truncates or
// folds a line back on itself, causing several real stations to project to
// the same vertex. Without dedup the per-station dwell scheduler would
// stack multiple 20s holds on the same geographic point and the train would
// appear frozen there.
const minStationSepMetres = 75.0

// projectAndOrderStations finds each station's closest point on the polyline,
// records its distance-along, sorts by that distance, and drops near-duplicate
// projections so the trip schedule sees a clean station sequence.
func projectAndOrderStations(stns []station, pl polyline) []station {
	tmp := make([]station, 0, len(stns))
	for _, s := range stns {
		s.distAlong = projectStation(s, pl)
		tmp = append(tmp, s)
	}
	sort.Slice(tmp, func(i, j int) bool { return tmp[i].distAlong < tmp[j].distAlong })

	out := tmp[:0]
	for _, s := range tmp {
		if len(out) > 0 && s.distAlong-out[len(out)-1].distAlong < minStationSepMetres {
			continue
		}
		out = append(out, s)
	}
	return out
}

func projectStation(s station, pl polyline) float64 {
	p := point{lng: s.Lng, lat: s.Lat}
	bestD2 := math.Inf(1)
	bestAlong := 0.0
	for i := 1; i < len(pl.pts); i++ {
		a := pl.pts[i-1]
		b := pl.pts[i]
		_, t, d2 := projectOnSegment(p, a, b)
		if d2 < bestD2 {
			bestD2 = d2
			segLen := pl.cum[i] - pl.cum[i-1]
			bestAlong = pl.cum[i-1] + t*segLen
		}
	}
	return bestAlong
}
