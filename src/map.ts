import L from "leaflet";

export const ISTANBUL_CENTER: L.LatLngTuple = [41.015137, 28.97953];
export const ISTANBUL_BOUNDS: L.LatLngBoundsLiteral = [
  [40.78, 28.45],
  [41.32, 29.62],
];

export function createMap(container: HTMLElement): L.Map {
  const map = L.map(container, {
    center: ISTANBUL_CENTER,
    zoom: 11,
    minZoom: 9,
    maxBounds: ISTANBUL_BOUNDS,
    maxBoundsViscosity: 0.7,
    zoomControl: false,
    attributionControl: true,
  });

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }
  ).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  return map;
}

export function makeEndpointMarker(
  kind: "start" | "end",
  latlng: L.LatLngExpression
): L.Marker {
  const color = kind === "start" ? "#10b981" : "#ef4444";
  const html = `
    <div style="
      width: 22px; height: 22px; border-radius: 999px;
      background: ${color};
      border: 3px solid #fff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    "></div>`;
  const icon = L.divIcon({
    className: "endpoint-marker",
    html,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  return L.marker(latlng, { icon });
}
