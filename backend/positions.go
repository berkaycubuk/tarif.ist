package main

import "math"

// TrainPosition is one simulated train at request time.
//
// This is pure schedule data — *where on the route the train is*, expressed
// in station-relative terms. There's no lat/lng: that's a rendering decision
// for the client. The same response shape works equally well for a map UI,
// a list of "next train" predictions, or any other consumer.
type TrainPosition struct {
	// TrainIdx is stable per line: the i-th train phase-offset on the loop.
	// Same TrainIdx returned by repeated requests refers to the same vehicle,
	// which lets clients animate movement instead of teleporting markers.
	TrainIdx int `json:"trainIdx"`

	// Direction: "ab" runs first-station → last, "ba" the reverse.
	// "dwell" means the train is sitting at a station or terminus.
	Direction string `json:"direction"`

	// FromStation is the station the train just left or is currently dwelling
	// at. ToStation is the next station it will arrive at. They're equal iff
	// the train is dwelling (also indicated by Direction == "dwell").
	FromStation string `json:"fromStation"`
	ToStation   string `json:"toStation"`

	// SegmentProgress is the fraction (0..1) completed within the current
	// travel segment from FromStation to ToStation. Always 0 while dwelling.
	SegmentProgress float64 `json:"segmentProgress"`

	// SecondsToNext is the time remaining until the train reaches ToStation.
	// While dwelling, this is the time remaining in the dwell — i.e. how
	// long until the train departs the current station.
	SecondsToNext float64 `json:"secondsToNext"`
}

// PositionsFor computes the position of every train on a line at time t
// (seconds since the unix epoch — fractional ok).
//
// Model: trains are evenly spaced on a closed loop of length
//
//	cycle = trainCount * headwaySec
//
// One A→B trip takes tripDurationSec; the remaining (cycle/2 - tripDurationSec)
// per half-loop is modelled as terminal dwell. This is an approximation — the
// network doesn't expose live positions, so we use headway as ground truth
// (since trainCount × headway is the cadence riders actually experience) and
// fit the trip into each half. The simulation matches reality up to schedule
// adherence, which is the best you can do without telemetry.
func (l *Line) PositionsFor(t float64) []TrainPosition {
	if l.trainCount <= 0 || l.headwaySec <= 0 || l.tripDurationSec <= 0 {
		return nil
	}
	if len(l.stations) < 2 || len(l.schedule) == 0 {
		return nil
	}
	cycle := float64(l.trainCount) * l.headwaySec
	if cycle <= 0 {
		return nil
	}
	half := cycle / 2
	// Trip can't exceed the half-cycle, or A→B would overlap the return leg.
	// If headway data implies that, clamp so we still draw something sensible.
	tripDur := l.tripDurationSec
	if tripDur > half {
		tripDur = half
	}
	first := l.stations[0]
	last := l.stations[len(l.stations)-1]

	out := make([]TrainPosition, 0, l.trainCount)
	for i := 0; i < l.trainCount; i++ {
		phase := math.Mod(t+float64(i)*l.headwaySec, cycle)
		if phase < 0 {
			phase += cycle
		}

		var direction string
		var fromName, toName string
		var segFrac, secsToNext float64

		switch {
		case phase < tripDur:
			// A→B leg.
			direction = "ab"
			seg, f := l.segmentAtTripTime(phase)
			segFrac = f
			fromName, toName = stationNames(l.stations, seg, false)
			secsToNext = seg.endSec - phase
		case phase < half:
			// Dwell at B terminus.
			direction = "dwell"
			fromName, toName = last.Name, last.Name
			secsToNext = half - phase
		case phase < half+tripDur:
			// B→A leg: replay the A→B schedule in reverse time. The schedule
			// is symmetric, so the underlying segment lookup is the same when
			// called at (tripDur - tripT); we just mirror the user-facing
			// fields so progress reads as "fraction completed B→A" rather
			// than tracking the underlying A→B direction.
			tripT := phase - half
			direction = "ba"
			seg, f := l.segmentAtTripTime(tripDur - tripT)
			fromName, toName = stationNames(l.stations, seg, true)
			if seg.startIdx == seg.endIdx {
				segFrac = 0
			} else {
				segFrac = 1 - f
			}
			secsToNext = (tripDur - tripT) - seg.startSec
		default:
			// Dwell at A terminus.
			direction = "dwell"
			fromName, toName = first.Name, first.Name
			secsToNext = cycle - phase
		}

		// Treat any segment where from == to as a dwell — covers intermediate
		// station holds without the client having to compare names.
		if direction != "dwell" && fromName == toName {
			direction = "dwell"
		}
		if secsToNext < 0 {
			secsToNext = 0
		}

		out = append(out, TrainPosition{
			TrainIdx:        i,
			Direction:       direction,
			FromStation:     fromName,
			ToStation:       toName,
			SegmentProgress: segFrac,
			SecondsToNext:   secsToNext,
		})
	}
	return out
}

// stationNames returns the (from, to) station names for a schedule segment.
// For dwell segments (startIdx == endIdx) both names are the same — the
// station the train is sitting at. The `reversed` flag swaps from/to so the
// B→A leg reports the correct heading.
func stationNames(stns []station, seg tripSegment, reversed bool) (from, to string) {
	a := stns[seg.startIdx]
	b := stns[seg.endIdx]
	if seg.startIdx == seg.endIdx {
		return a.Name, a.Name
	}
	if reversed {
		return b.Name, a.Name
	}
	return a.Name, b.Name
}
