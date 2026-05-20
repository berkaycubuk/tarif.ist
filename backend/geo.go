package main

import "math"

// Equirectangular projection scaled to metres around Istanbul. The whole
// network is small enough (~80km across) that the latitude-cosine factor
// can be a single constant — saves a trig call per distance.
const istanbulLatCosRad = 0.7547 // cos(41°) ≈ 0.7547
const metresPerDegLat = 111320.0
const metresPerDegLng = metresPerDegLat * istanbulLatCosRad

type point struct{ lng, lat float64 } // GeoJSON order: [lng, lat]

func (p point) distTo(q point) float64 {
	dx := (p.lng - q.lng) * metresPerDegLng
	dy := (p.lat - q.lat) * metresPerDegLat
	return math.Sqrt(dx*dx + dy*dy)
}

// Project point p onto segment a→b. Returns the projected point, the
// fractional position t∈[0,1] along the segment, and squared distance
// in metres² from p to the projection.
func projectOnSegment(p, a, b point) (point, float64, float64) {
	abx := (b.lng - a.lng) * metresPerDegLng
	aby := (b.lat - a.lat) * metresPerDegLat
	apx := (p.lng - a.lng) * metresPerDegLng
	apy := (p.lat - a.lat) * metresPerDegLat
	ab2 := abx*abx + aby*aby
	if ab2 == 0 {
		dx := apx
		dy := apy
		return a, 0, dx*dx + dy*dy
	}
	t := (apx*abx + apy*aby) / ab2
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	proj := point{
		lng: a.lng + (b.lng-a.lng)*t,
		lat: a.lat + (b.lat-a.lat)*t,
	}
	dpx := apx - abx*t
	dpy := apy - aby*t
	return proj, t, dpx*dpx + dpy*dpy
}
