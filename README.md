# Shadow Fleet Tracker

Shadow Fleet Tracker is an interactive map for exploring vessel movements and spotting unusual AIS activity.

Intended users: journalists, researchers, analysts, and anyone using the map to inspect vessel movements — not developers.

What we track
- Sanctioned vessels (including those under sanctions related to Russia).
- Vessels identified as part of the so-called "shadow fleet" (obscured ownership, deceptive reporting).
- Military and law-enforcement vessels, including units involved in seizure actions and enforcement around those sanctioned or shadow vessels.

What you can do with the map
- View vessel positions and basic ship metadata (name, flag, type, last-seen time).
- Toggle visible layers: ports, submarine cables, and pipelines to understand proximity and infrastructure.
- Open a vessel's details panel to see extra links and further ship information (external references and available images when present).
- Play back AIS tracks for one or more vessels: see traveled vs. untraveled path, move a playhead through time, and watch vessel markers animate along historic routes.
- Detect mooring events: vessels remaining within 10 km of a port for 4+ hours are listed in the log.
- Detect AIS anomalies: land crossings, very high speeds, and large jumps are highlighted during playback and recorded in the legend log.

Where the data comes from
- Ships and metadata are loaded from `ships.json` (local dataset used by the map).
- Per-vessel track files live in `tracks/` as `tracks/<id>.json` and are loaded on demand when you start playback.
- Port locations are provided in `ports.json` and are used for proximity/mooring detection.
- Country polygons in `countries.geojson` are used to detect when AIS reports are on land.

Basic usage (quick)
1. Start a simple static server in the project root and open the map in your browser:

	```bash
	python3 -m http.server 8000
	# open http://localhost:8000
	```

2. Use the legend (top-right) to toggle layers and controls.
3. Click a ship marker to open its details panel — follow links or view images when available.
4. To play back tracks, open the playback modal, select one or more vessels, and press Play. The timeline uses 30-minute steps by default.
5. Check the log in the legend for mooring entries or AIS anomaly records.

Notes for map users
- Cables and pipelines are shown as separate layers to help contextualize vessel positions near critical infrastructure.
- The log collects both mooring events and anomalies so you can review suspect tracks without hunting on the map.
- Some ships include links to external data sources and thumbnails when available — open the details panel for those links.



