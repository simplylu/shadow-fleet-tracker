/* Global app script for ShadowFleet map */
const map = L.map('map', {zoomControl: true}).setView([55, 13], 6);

// Use a basemap with Latin/English labels for readability (CartoDB Voyager)
// Base layers: Voyager (light) and Dark Matter (dark)
const lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd'
});
const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd'
});

// Add default layer; we provide a simple legend checkbox to toggle dark/light
lightLayer.addTo(map);
window.__darkMode = false;
function setDarkMode(on){
  window.__darkMode = !!on;
  try{
    if(window.__darkMode){ if(map.hasLayer(lightLayer)) map.removeLayer(lightLayer); if(!map.hasLayer(darkLayer)) map.addLayer(darkLayer); }
    else { if(map.hasLayer(darkLayer)) map.removeLayer(darkLayer); if(!map.hasLayer(lightLayer)) map.addLayer(lightLayer); }
  }catch(e){ console.debug('setDarkMode error', e); }
}

// ---------------------- Playback subsystem ----------------------
// Simple playback: loads /tracks/<key>.json (array of {timestamp,lat,lon}),
// renders polylines + moving markers and provides a timeline UI.

window.__playbackTracks = {};
window.__playbackLayer = L.layerGroup().addTo(map);
window.__playbackState = { currentTime:null, globalMin:null, globalMax:null, playing:false, speed:10, preferredUnit:1800, rafId:null };

function parsePointTimestamp(s){
  if(s === undefined || s === null) return null;
  if(typeof s === 'number'){
    if(s > 1e12) return Math.floor(s/1000);
    return Math.floor(s);
  }
  let t = String(s).trim();
  if(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(t)) t = t.replace(/\s+/, 'T');
  const n = parseFloat(t);
  if(!Number.isNaN(n) && /^\d+(?:\.\d+)?$/.test(t)){
    if(n > 1e12) return Math.floor(n/1000);
    return Math.floor(n);
  }
  const d = Date.parse(t);
  if(!Number.isNaN(d)) return Math.floor(d/1000);
  return null;
}

async function loadTracksForKeys(keys){
  if(!Array.isArray(keys)) keys = [];
  window.__playbackTracks = {};
  let gmin = Infinity, gmax = -Infinity;
  const loaded = [];
  for(const k of keys){
    try{
      const url = `tracks/${encodeURIComponent(String(k))}.json`;
      const r = await fetch(url);
      if(!r.ok) continue;
      const pts = await r.json();
      if(!Array.isArray(pts) || pts.length===0) continue;
      const points = pts.map(p=>{
        const ts = parsePointTimestamp(p.timestamp || p.time || p.t || p.ts || p[0]);
        return {ts: ts, lat: parseFloat(p.lat||p.latitude), lon: parseFloat(p.lon||p.lng||p.longitude)};
      }).filter(p=>p && Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if(points.length===0) continue;
      points.sort((a,b)=>a.ts-b.ts);
      const min = points[0].ts, max = points[points.length-1].ts;
      if(min < gmin) gmin = min; if(max > gmax) gmax = max;
      window.__playbackTracks[String(k)] = {points, min, max, polyline:null, marker:null};
      loaded.push(String(k));
    }catch(e){ console.debug('loadTracksForKeys failed for', k, e); }
  }
  if(loaded.length===0){ window.__playbackState.globalMin = null; window.__playbackState.globalMax = null; return; }
  window.__playbackState.globalMin = gmin; window.__playbackState.globalMax = gmax;
  // initialize current time to global start so timeline and markers show immediately
  window.__playbackState.currentTime = gmin;
  try{ console.warn('loadTracksForKeys: loaded playback tracks', loaded.join(', ')); }catch(e){}
  renderPlaybackPolylines();
  setupPlaybackTimeline();
  // update marker positions and timeline indicator to the initial time
  try{ updatePlaybackForTime(window.__playbackState.currentTime); }catch(e){ console.debug('initial updatePlaybackForTime failed', e); }
}

function renderPlaybackPolylines(){
  try{ window.__playbackLayer.clearLayers(); }catch(e){}
  // color palette for distinguishing ships
  const palette = ['#ff6b6b','#6bafff','#ffd36b','#7be36b','#d86bff','#6bffd9','#ff8c6b','#6b9bff'];
  let idx = 0;
  for(const k in window.__playbackTracks){
    const t = window.__playbackTracks[k];
    const latlngs = t.points.map(p=>[p.lat,p.lon]);
    try{
      const color = palette[idx % palette.length]; idx += 1;
      // base (untraveled) polyline: dimmer
      t.basePolyline = L.polyline(latlngs, {color: color, weight:3, opacity:0.45, dashArray: null});
      // traveled polyline: will be updated during playback to show the path already covered
      t.traveledPolyline = L.polyline([], {color: color, weight:4, opacity:1.0});
      t.marker = L.circleMarker(latlngs[0], {radius:6, fillColor:color, color:color, weight:1, fillOpacity:0.95});
      window.__playbackLayer.addLayer(t.basePolyline);
      window.__playbackLayer.addLayer(t.traveledPolyline);
      window.__playbackLayer.addLayer(t.marker);
      // try to color the original map icon for the same ship key so users can match track->ship
      try{
        const shipKey = String(k);
        for(const mm of markers){
          try{
            const mk = String(getShipPlaybackKey(mm.item)||'');
            if(mk === shipKey){
              try{ mm.marker.setIcon(makeLabelIcon(mm.item, color)); }catch(e){}
              break;
            }
          }catch(e){}
        }
      }catch(e){ console.debug('coloring main marker failed', e); }
      // add a permanent tooltip/label to the playback marker so the moving dot is clearly labeled
      try{
        const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })();
        t.marker.bindTooltip(shipName, {permanent:true, direction:'right', className:'playback-tooltip'});
      }catch(e){}

      // detect suspicious segments for this track (large jumps, high speeds, points near ports)
      try{
        if(Array.isArray(t.points) && t.points.length>2){
          t.__badSegments = detectBadTrackSegments(t.points, {maxSpeedKnots:60, maxJumpKm:30, maxJumpTimeS:3600, portNearMeters:500, contiguousLandSeconds:1800});
              try{ console.warn('renderPlaybackPolylines: track', k, 'badSegments=', (t.__badSegments||[]).length); }catch(e){}
          // visualize flagged segments
          try{ if(t.__badSegments && t.__badSegments.length){ t.badLayer = L.layerGroup(); for(const f of t.__badSegments){ try{ const a = t.points[Math.max(0,f.i-1)]; const b = t.points[Math.max(0,f.i)]; if(!a||!b) continue; const seg = L.polyline([[a.lat,a.lon],[b.lat,b.lon]], {color:'#ff3b30', weight:3, opacity:0.95, dashArray:'6,6', className:'playback-anomaly'}); t.badLayer.addLayer(seg); }catch(e){} } window.__playbackLayer.addLayer(t.badLayer); } }catch(e){}
          // decide whether to append an anomaly log or mark the ship: only alert continuous port/land signals
          try{
            // helper to mark the playback track anomalous: persist state, badge, tooltip, log and console warning
            function markPlaybackTrackAnomaly(trackObj, trackKey, reason, startTs, msg){
              try{
                try{ console.warn('markPlaybackTrackAnomaly invoked', String(trackKey), reason, startTs); }catch(e){}
                if(!trackObj) return;
                trackObj._anomalyActive = true;
                trackObj._anomalyStartTs = Number(startTs) || Math.floor(Date.now()/1000);
                // persist on item and update main marker
                for(const mm of markers){ try{ const mk = String(getShipPlaybackKey(mm.item)||''); if(mk===String(trackKey)){
                      try{ if(mm.item) mm.item._anomalyActive = true; }catch(e){}
                      const el = (mm.marker && mm.marker.getElement) ? mm.marker.getElement() : null;
                      if(el){ const wrap = el.querySelector('.ship-marker-wrap'); if(wrap) wrap.classList.add('anomaly'); }
                      try{ if(mm.marker && typeof mm.marker.setIcon === 'function') mm.marker.setIcon(makeLabelIcon(mm.item)); }catch(e){}
                      break;
                    } }catch(e){}
                }
                // update playback marker tooltip immediately
                  try{
                    if(trackObj.marker){
                      const shipNameNow = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(trackKey)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(trackKey); }catch(e){ return String(trackKey); } })();
                      try{ trackObj.marker.unbindTooltip(); }catch(e){}
                      try{ trackObj.marker.bindTooltip(shipNameNow + ' ⚠️', {permanent:true, direction:'right', className:'playback-tooltip playback-warning'}); }catch(e){}
                    }
                  }catch(e){}
                // append a single log entry if not already done
                if(!trackObj._anomalyLogged){
                  const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(trackKey)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(trackKey); }catch(e){ return String(trackKey); } })();
                  appendAnomalyLog(trackObj._anomalyStartTs || startTs || Math.floor(Date.now()/1000), shipName, msg || (reason === 'on_land' ? 'Continuous AIS signals on land' : 'AIS anomaly'));
                  trackObj._anomalyLogged = true;
                }
                try{ console.warn('Playback anomaly:', trackKey, reason, startTs, msg); }catch(e){}
              }catch(e){ console.debug('markPlaybackTrackAnomaly failed', e); }
            }
              // expose for runtime calls from playback loop
              try{ window.markPlaybackTrackAnomaly = markPlaybackTrackAnomaly; }catch(e){}

            // group 'near_port' or 'on_land' consecutive runs
            const runs = [];
            let cur = null;
            for(const f of (t.__badSegments||[])){
              if(f.reason !== 'near_port' && f.reason !== 'on_land') continue;
              if(!cur) cur = {startIdx: Math.max(0,f.i-1), endIdx: Math.max(0,f.i), startTs: t.points[Math.max(0,f.i-1)].ts || t.points[Math.max(0,f.i-1)].timestamp || t.points[Math.max(0,f.i-1)].time, endTs: t.points[Math.max(0,f.i)].ts || t.points[Math.max(0,f.i)].timestamp || t.points[Math.max(0,f.i)].time, ports: [f.portName||''], reasons: [f.reason] };
              else { cur.endIdx = Math.max(cur.endIdx, f.i); cur.endTs = t.points[Math.max(0,f.i)].ts || t.points[Math.max(0,f.i)].timestamp || t.points[Math.max(0,f.i)].time; if(f.portName) cur.ports.push(f.portName); if(f.reason) cur.reasons.push(f.reason); }
              // when gap to next flagged isn't contiguous we will finalize when loop ends; we'll finalize below
            }
            if(cur){ const dur = (Number(cur.endTs)||0) - (Number(cur.startTs)||0); if(dur >=  (1800) ){ // contiguousLandSeconds default
                const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })();
                const portName = cur.ports && cur.ports.length ? cur.ports[0] : '';
                const reason = (cur.reasons && cur.reasons.length) ? cur.reasons[0] : 'near_port';
                const msg = (reason === 'on_land') ? 'Continuous AIS signals on land' : `Continuous land/port AIS signals near ${portName||'port'}`;
                try{ markPlaybackTrackAnomaly(t,k,reason,cur.startTs,msg); }catch(e){}
              }
            }
            // also, if any bad segment flagged 'on_land' exists (detectBadTrackSegments produces 'on_land' only after contiguous threshold), ensure persistent warning and log if not already logged
            try{
              const anyOnLand = (t.__badSegments||[]).some(x=>x && x.reason === 'on_land');
              if(anyOnLand && !t._anomalyLogged){
                const first = (t.__badSegments||[]).find(x=>x && x.reason === 'on_land');
                try{ markPlaybackTrackAnomaly(t,k,'on_land', (first && first.startTs) || (t.points && t.points[0] && t.points[0].ts) || Math.floor(Date.now()/1000), 'Continuous AIS signals on land'); }catch(e){}
              }
            }catch(e){}
          }catch(e){}
        }
      }catch(e){}
    }catch(e){ console.debug('renderPlaybackPolylines failed for', k, e); }
  }
}

function setupPlaybackTimeline(){
  // build UI if missing
  if(!window.__playbackUI) showPlaybackBar();
  const info = window.__playbackState;
  const gmin = info.globalMin, gmax = info.globalMax;
  const canvas = document.getElementById('pb-canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const parentW = (canvas.parentElement||canvas).clientWidth || 300;
  const dpr = Math.max(1, devicePixelRatio||1);
  const w = Math.max(200, Math.floor(parentW * dpr));
  const h = Math.max(28, Math.floor(36 * dpr));
  canvas.width = w; canvas.height = h; canvas.style.width = (parentW+'px'); canvas.style.height = (h/dpr)+'px';
  const pxPerSec = (w) / Math.max(1, (gmax - gmin));
  const unit = info.preferredUnit || 1800;
  // draw background subtle gradient
  ctx.clearRect(0,0,w,h);
  const grad = ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'rgba(255,255,255,0.02)'); grad.addColorStop(1,'rgba(0,0,0,0.03)');
  ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
  // draw faint alternating bands with low opacity, but if there are many units, draw thinner lines instead
  const totalUnits = Math.max(1, Math.ceil((gmax - gmin) / unit));
  if(totalUnits <= 120){
    for(let t = Math.floor(gmin/unit)*unit; t<=gmax; t+=unit){
      const bandWidth = Math.max(2, Math.round(unit * pxPerSec));
      const x = Math.round((t - gmin) * pxPerSec);
      ctx.fillStyle = ((Math.floor((t - gmin)/unit) % 2) === 0) ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)';
      ctx.fillRect(x, Math.round(h*0.06), Math.max(1, bandWidth), Math.round(h*0.88));
    }
  } else {
    // many units: draw subtle vertical hairlines spaced to avoid solid white blocks
    const maxLines = 80;
    const step = Math.max(1, Math.floor(totalUnits / maxLines));
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = Math.max(1, Math.min(2, Math.floor(dpr)));
    for(let i=0;i<totalUnits;i+=step){
      const t = Math.floor(gmin/unit)*unit + i*unit;
      const x = Math.round((t - gmin) * pxPerSec) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, Math.round(h*0.12)); ctx.lineTo(x, Math.round(h*0.88)); ctx.stroke();
    }
  }
  // subtle bands only — no ticks or labels to avoid visual clutter
  // draw initial indicator (playhead)
  function drawIndicator(ts){
    // redraw background bands and ticks then overlay playhead
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
    if(totalUnits <= 120){
      for(let t = Math.floor(gmin/unit)*unit; t<=gmax; t+=unit){
        const bandWidth = Math.max(2, Math.round(unit * pxPerSec));
        const x = Math.round((t - gmin) * pxPerSec);
        ctx.fillStyle = ((Math.floor((t - gmin)/unit) % 2) === 0) ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)';
        ctx.fillRect(x, Math.round(h*0.06), Math.max(1, bandWidth), Math.round(h*0.88));
      }
    } else {
      const maxLines = 80;
      const step = Math.max(1, Math.floor(totalUnits / maxLines));
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = Math.max(1, Math.min(2, Math.floor(dpr)));
      for(let i=0;i<totalUnits;i+=step){
        const t = Math.floor(gmin/unit)*unit + i*unit;
        const x = Math.round((t - gmin) * pxPerSec) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, Math.round(h*0.12)); ctx.lineTo(x, Math.round(h*0.88)); ctx.stroke();
      }
    }
    const curX = Math.round((ts - gmin) * pxPerSec);
    // playhead: vertical line + small circle handle
    ctx.fillStyle = 'rgba(255,120,0,0.95)'; ctx.fillRect(curX-1, 0, 2, h);
    ctx.beginPath(); ctx.arc(curX, Math.round(h*0.5), Math.round(h*0.18), 0, Math.PI*2); ctx.fill();
  }
  window.__playbackDrawIndicator = drawIndicator;
  if(window.__playbackState.currentTime) drawIndicator(window.__playbackState.currentTime);
  // add seeking
  let dragging = false;
  function seekFromClientX(clientX){
    const rect = canvas.getBoundingClientRect(); const x = clientX - rect.left; const frac = Math.max(0, Math.min(1, x / rect.width));
    const raw = Math.floor(gmin + frac * (gmax - gmin));
    const unit = window.__playbackState.preferredUnit || 1800; const ts = Math.round(raw / unit) * unit;
    window.__playbackState.currentTime = ts; updatePlaybackForTime(ts);
  }
  canvas.onmousedown = (ev)=>{ ev.preventDefault(); dragging = true; seekFromClientX(ev.clientX); };
  window.addEventListener('mousemove', ev=>{ if(!dragging) return; seekFromClientX(ev.clientX); });
  window.addEventListener('mouseup', ev=>{ if(!dragging) return; dragging=false; seekFromClientX(ev.clientX); });
}

// keyboard: spacebar toggles play/pause while playback UI is visible
function attachPlaybackKeyboard(){
  try{
    if(window.__playbackKeyHandler) return;
    window.__playbackKeyHandler = function(e){
      if(e.key !== ' ' && e.code !== 'Space') return;
      const active = document.activeElement; if(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      if(!window.__playbackUI) return;
      e.preventDefault(); try{ const btn = document.getElementById('pb-play'); if(btn) btn.click(); }catch(err){}
    };
    document.addEventListener('keydown', window.__playbackKeyHandler);
  }catch(e){ console.debug('attachPlaybackKeyboard failed', e); }
}

function detachPlaybackKeyboard(){ try{ if(window.__playbackKeyHandler){ document.removeEventListener('keydown', window.__playbackKeyHandler); window.__playbackKeyHandler = null; } }catch(e){}
}

function updatePlaybackForTime(ts){
  if(ts === null || ts === undefined) return;
  const state = window.__playbackState; if(!state.globalMin) return;
  try{ console.warn('updatePlaybackForTime called', ts, 'tracks=', Object.keys(window.__playbackTracks||{}).length); }catch(e){}
  const uiTime = document.getElementById('pb-time'); if(uiTime) uiTime.textContent = new Date(ts*1000).toISOString().slice(0,16).replace('T',' ');
  // helper: compute distance in meters between two lat/lon
  function haversineMeters(lat1, lon1, lat2, lon2){
    const toRad = v => v*Math.PI/180;
    const R = 6371000;
    const dLat = toRad(lat2-lat1); const dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  // detector for bad track segments
  function detectBadTrackSegments(points, opts){
    opts = opts || {};
    const maxSpeedKnots = opts.maxSpeedKnots || 60;
    const maxSpeedMS = maxSpeedKnots * 0.514444;
    const maxJumpM = (opts.maxJumpKm||30) * 1000;
    const maxJumpTimeS = opts.maxJumpTimeS || 3600;
    const portNearMeters = opts.portNearMeters || 500;
    const contiguousLandSeconds = opts.contiguousLandSeconds || 1800;
    const flagged = [];
    try{
      // helper: point-in-ring (ray-casting)
      function pointInRing(lon, lat, ring){
        let inside = false;
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const xi = ring[i][0], yi = ring[i][1];
          const xj = ring[j][0], yj = ring[j][1];
          const intersect = ((yi>lat) !== (yj>lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi);
          if(intersect) inside = !inside;
        }
        return inside;
      }
      function isPointOnLand(lat, lon){
        try{
          const polys = Array.isArray(window.__countryPolygons) ? window.__countryPolygons : [];
          for(const p of polys){
            try{
              const rings = p.rings || [];
              if(!rings || !rings.length) continue;
              // first ring is outer
              if(pointInRing(lon, lat, rings[0])){
                // ensure not in any hole
                let inHole = false;
                for(let h=1; h<rings.length; h++){
                  if(pointInRing(lon, lat, rings[h])){ inHole = true; break; }
                }
                if(!inHole) return true;
              }
            }catch(e){}
          }
        }catch(e){}
        return false;
      }

      let landRunStart = null; let landRunStartTs = null;
      const staticThresholdM = 50; // preserve jump/static checks for speed/jump detection but drop long_static
      for(let i=1;i<points.length;i++){
        const a = points[i-1]; const b = points[i];
        const at = Number(a.ts||a.timestamp||a.time||0); const bt = Number(b.ts||b.timestamp||b.time||0);
        const dt = Math.max(1, bt - at);
        const dist = haversineMeters(a.lat,a.lon,b.lat,b.lon);
        const speed = dist / dt;
        if(speed > maxSpeedMS){ flagged.push({i,reason:'high_speed',dist,dt,speed}); landRunStart = null; continue; }
        if(dist > maxJumpM && dt < maxJumpTimeS){ flagged.push({i,reason:'large_jump',dist,dt,speed}); landRunStart = null; continue; }
        // check proximity to ports (if loaded)
        if(Array.isArray(window.__portsData) && window.__portsData.length){
          let nearest = null; let nd = Infinity; let pname = '';
          for(const pf of window.__portsData){ try{ const coords = pf.geometry && pf.geometry.coordinates ? pf.geometry.coordinates : null; if(!coords||coords.length<2) continue; const plon = parseFloat(coords[0]); const plat = parseFloat(coords[1]); if(!Number.isFinite(plon)||!Number.isFinite(plat)) continue; const d = haversineMeters(b.lat,b.lon,plat,plon); if(d < nd){ nd = d; nearest = pf; pname = (pf.properties && (pf.properties.name||pf.properties.port||pf.properties.title)) ? String(pf.properties.name||pf.properties.port||pf.properties.title) : ''; } }catch(e){} }
          if(nearest && nd <= portNearMeters){ flagged.push({i,reason:'near_port',dist:nd,portName:pname,dt,speed}); landRunStart = null; continue; }
        }
        // detect contiguous on-land runs using preloaded country polygons
        const onLand = isPointOnLand(b.lat, b.lon);
        if(onLand){
          if(landRunStart === null){ landRunStart = i-1; landRunStartTs = at; }
        } else {
          if(landRunStart !== null){
            const dur = at - (landRunStartTs||at);
            if(dur >= (opts.contiguousLandSeconds || 1800)){
              flagged.push({i: i, reason:'on_land', startIdx: landRunStart, endIdx: i, startTs: landRunStartTs, endTs: at, dur});
            }
            landRunStart = null; landRunStartTs = null;
          }
        }
      }
      // finalize any trailing land run
      if(landRunStart !== null){
        const last = points[points.length-1];
        const lastTs = Number(last.ts||last.timestamp||last.time||0);
        const dur = lastTs - (landRunStartTs||lastTs);
        if(dur >= (opts.contiguousLandSeconds || 1800)){
          flagged.push({i: points.length-1, reason:'on_land', startIdx: landRunStart, endIdx: points.length-1, startTs: landRunStartTs, endTs: lastTs, dur});
        }
      }
    }catch(e){ console.debug('detectBadTrackSegments failed', e); }
    return flagged;
  }

  // append a mooring log entry to the legend log
  function appendMooringLog(ts, shipName, portName){
    try{
      ensureLegend();
      const log = document.getElementById('mooringLog'); if(!log) return;
      // create an entry styled similarly to legend rows
      const entry = document.createElement('div'); entry.className = 'legend-row map-log-entry';
      entry.style.display = 'flex'; entry.style.flexDirection = 'column'; entry.style.alignItems = 'flex-start';
      const timeEl = document.createElement('time'); timeEl.textContent = new Date(ts*1000).toISOString().slice(0,16).replace('T',' ');
      timeEl.style.fontWeight = '700'; timeEl.style.color = '#e6eef6';
      const txt = document.createElement('div');
      const shipEl = document.createElement('span'); shipEl.textContent = shipName; shipEl.style.fontWeight = '700'; shipEl.style.marginRight = '8px';
      const atEl = document.createElement('span'); atEl.textContent = `moored at ${portName}`; atEl.style.color = 'var(--muted)';
      txt.appendChild(shipEl); txt.appendChild(atEl);
      entry.appendChild(timeEl);
      entry.appendChild(txt);
      log.insertBefore(entry, log.firstChild);
      // limit log size
      while(log.children.length > 200) log.removeChild(log.lastChild);
    }catch(e){ console.debug('appendMooringLog failed', e); }
  }
  // append anomaly messages to the same log area
  function appendAnomalyLog(ts, shipName, msg){
    try{
      ensureLegend();
      const log = document.getElementById('mooringLog'); if(!log) return;
      const entry = document.createElement('div'); entry.className = 'legend-row map-log-entry';
      entry.style.display = 'flex'; entry.style.flexDirection = 'column'; entry.style.alignItems = 'flex-start';
      const timeEl = document.createElement('time'); timeEl.textContent = new Date(Number(ts)*1000).toISOString().slice(0,16).replace('T',' ');
      timeEl.style.fontWeight = '700'; timeEl.style.color = '#ffd4d4';
      const txt = document.createElement('div');
      const shipEl = document.createElement('span'); shipEl.textContent = shipName; shipEl.style.fontWeight = '700'; shipEl.style.marginRight = '8px';
      const atEl = document.createElement('span'); atEl.textContent = '⚠️ ' + msg; atEl.style.color = 'var(--muted)';
      txt.appendChild(shipEl); txt.appendChild(atEl);
      entry.appendChild(timeEl); entry.appendChild(txt);
      log.insertBefore(entry, log.firstChild);
      try{ console.warn('Anomaly log:', shipName, msg, new Date(Number(ts)*1000).toISOString()); }catch(e){}
      while(log.children.length > 200) log.removeChild(log.lastChild);
    }catch(e){ console.debug('appendAnomalyLog failed', e); }
  }
  for(const k in window.__playbackTracks){
    const t = window.__playbackTracks[k]; if(!t || !t.points || t.points.length===0) continue;
    if(ts < t.min){
      // before this track starts: show marker at its first point (dimmed)
      try{ const first = t.points[0]; t.marker.setLatLng([first.lat, first.lon]); t.marker.setStyle({opacity:0.85, fillOpacity:0.6}); }catch(e){}
      // clear traveled polyline
      try{ if(t.traveledPolyline) t.traveledPolyline.setLatLngs([]); }catch(e){}
      continue;
    }
    if(ts >= t.max){
      const last = t.points[t.points.length-1];
      try{ t.marker.setStyle({opacity:1,fillOpacity:0.95}); t.marker.setLatLng([last.lat,last.lon]); }catch(e){}
      // set traveled polyline to full track
      try{ const all = t.points.map(p=>[p.lat,p.lon]); if(t.traveledPolyline) t.traveledPolyline.setLatLngs(all); }catch(e){}
      continue;
    }
    // binary search
    let lo=0, hi=t.points.length-1;
    while(lo<hi){ const mid = Math.floor((lo+hi)/2); if(t.points[mid].ts<=ts) lo=mid+1; else hi=mid; }
    const idx = Math.max(1, lo); const a = t.points[idx-1], b = t.points[idx];
    const frac = (ts - a.ts) / (b.ts - a.ts || 1);
    const lat = a.lat + (b.lat - a.lat) * frac; const lon = a.lon + (b.lon - a.lon) * frac;
    try{
      if(!t.marker) continue;
      t.marker.setStyle({opacity:1,fillOpacity:0.95}); t.marker.setLatLng([lat,lon]);
      // build traveled latlngs up to current interpolated position
      try{
        const done = [];
        for(let i=0;i<idx;i++){ done.push([t.points[i].lat, t.points[i].lon]); }
        // add interpolated current position
        done.push([lat, lon]);
        if(t.traveledPolyline) t.traveledPolyline.setLatLngs(done);
      }catch(e){}
          // show immediate warning on the moving label if current position is on land
        try{
          const onLandNow = (typeof isPointOnLand === 'function') ? isPointOnLand(lat, lon) : false;
          try{ if(onLandNow) console.warn('updatePlaybackForTime: onLandNow', k, ts, lat, lon); }catch(e){}
          // if we detect on-land for the moving point, persist the anomaly immediately so badge/log are created
          try{
            try{ console.warn('willCallMarkPlaybackTrackAnomaly?', String(k), 't._anomalyActive=', !!t._anomalyActive, 'hasFunc=', typeof window.markPlaybackTrackAnomaly); }catch(e){}
            if(onLandNow && !t._anomalyActive){
              // attempt to mark via helper first
              if(typeof window.markPlaybackTrackAnomaly === 'function'){
                try{ console.warn('calling markPlaybackTrackAnomaly for', String(k)); }catch(e){}
                try{ window.markPlaybackTrackAnomaly(t, k, 'on_land', ts, 'Immediate on-land AIS detected during playback'); }catch(e){ console.warn('markPlaybackTrackAnomaly call failed', e); }
              }
              // fallback: directly set anomaly state and update UI/log so user sees immediate effect
              try{
                console.warn('direct-marking anomaly fallback for', String(k));
                t._anomalyActive = true;
                t._anomalyStartTs = Number(ts) || Math.floor(Date.now()/1000);
                // append log entry only if not already logged
                try{ if(!t._anomalyLogged){ const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })(); appendAnomalyLog(t._anomalyStartTs, shipName, 'Immediate on-land AIS detected (fallback)'); t._anomalyLogged = true; } }catch(e){ console.warn('appendAnomalyLog fallback failed', e); }
                // decorate main marker(s)
                for(const mm of markers){ try{ const mk = String(getShipPlaybackKey(mm.item)||''); if(mk===String(k)){ try{ if(mm.item) mm.item._anomalyActive = true; }catch(e){} const el = (mm.marker && mm.marker.getElement)? mm.marker.getElement() : null; if(el){ const wrap = el.querySelector('.ship-marker-wrap'); if(wrap) wrap.classList.add('anomaly'); } try{ if(mm.marker && typeof mm.marker.setIcon === 'function') mm.marker.setIcon(makeLabelIcon(mm.item)); }catch(e){} break; } }catch(e){} }
              }catch(e){ console.warn('direct anomaly fallback failed', e); }
            }
          }catch(e){ console.warn('onLand immediate-mark branch failed', e); }
          const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })();
          try{ t.marker.unbindTooltip(); }catch(e){}
          // if this track was previously flagged as anomalous, keep showing the warning even when back on water
          const persistentWarn = !!t._anomalyActive;
          if(persistentWarn || onLandNow){ try{ t.marker.bindTooltip(shipName + ' ⚠️', {permanent:true, direction:'right', className:'playback-tooltip playback-warning'}); }catch(e){} }
          else { try{ t.marker.bindTooltip(shipName, {permanent:true, direction:'right', className:'playback-tooltip'}); }catch(e){} }
        }catch(e){}
      // mooring detection: if ports loaded, find nearest port within threshold
      try{
        const ports = Array.isArray(window.__portsData) ? window.__portsData : [];
        if(ports && ports.length){
          let nearest = null; let nearestDist = Infinity; let pname = '';
          for(const pf of ports){
            try{
              const coords = pf.geometry && pf.geometry.coordinates ? pf.geometry.coordinates : null; if(!coords||coords.length<2) continue;
              const plon = parseFloat(coords[0]); const plat = parseFloat(coords[1]); if(!Number.isFinite(plon)||!Number.isFinite(plat)) continue;
              const d = haversineMeters(lat, lon, plat, plon);
              if(d < nearestDist){ nearestDist = d; nearest = pf; pname = (pf.properties && (pf.properties.name||pf.properties.port||pf.properties.title)) ? String(pf.properties.name||pf.properties.port||pf.properties.title) : '' }
            }catch(e){}
          }
          // Use 10km proximity and require staying within that radius for 4 hours (14400s)
          const PROX_METERS = 10000; const PROX_SECONDS = 4 * 60 * 60;
          if(nearest && nearestDist <= PROX_METERS){
            // entering or staying within proximity
            if(!t._nearPortSince) t._nearPortSince = ts;
            // if stayed within proximity long enough and not yet logged, create mooring log
            if(t._nearPortSince && (ts - t._nearPortSince) >= PROX_SECONDS && !t._mooredLogged){
              const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })();
              appendMooringLog(t._nearPortSince, shipName, pname || 'port');
              t._mooredLogged = true;
            }
          } else {
            // left proximity: reset timers and flags
            t._nearPortSince = null;
            t._mooredLogged = false;
          }
        }
      }catch(e){}
      // store last pos
      t._lastPos = [lat, lon]; t._lastTs = ts;
      // if this track was previously flagged anomalous, ensure the main marker shows the persistent badge and log exists
      try{
        if(t._anomalyActive){
          // decorate main marker and item
          for(const mm of markers){ try{ const mk = String(getShipPlaybackKey(mm.item)||''); if(mk===String(k)){
                try{ if(mm.item) mm.item._anomalyActive = true; }catch(e){}
                const el = (mm.marker && mm.marker.getElement)? mm.marker.getElement() : null; if(el){ const wrap = el.querySelector('.ship-marker-wrap'); if(wrap) wrap.classList.add('anomaly'); }
                try{ if(mm.marker && typeof mm.marker.setIcon === 'function') mm.marker.setIcon(makeLabelIcon(mm.item)); }catch(e){}
                break;
          } }catch(e){} }
          // ensure a log entry exists once per anomaly
          if(!t._anomalyLogged){
            const shipName = (function(){ try{ const a = allShips.find(s=>String(getShipPlaybackKey(s)) === String(k)); return (a && (a.SHIPNAME||a.name)) ? String(a.SHIPNAME||a.name) : String(k); }catch(e){ return String(k); } })();
            const ts0 = Number(t._anomalyStartTs) || Number(t._nearPortSince) || Number(t._lastTs) || Math.floor(Date.now()/1000);
            appendAnomalyLog(ts0, shipName, 'AIS malfunction detected (on land)');
            t._anomalyLogged = true;
          }
        }
      }catch(e){}
    }catch(e){ console.debug('update marker failed', k, e); }
  }
  try{ if(window.__playbackDrawIndicator) window.__playbackDrawIndicator(ts); }catch(e){}
  try{ updateInactiveMarkers(); }catch(e){}
}

function startPlaybackLoop(){
  if(window.__playbackState.rafId) return;
  let last = performance.now(); let acc = 0;
  function loop(now){
    const dt = (now - last)/1000; last = now;
    if(window.__playbackState.playing){
      const speed = window.__playbackState.speed || 1; const unit = window.__playbackState.preferredUnit || 1800;
      const stepDelay = 0.5 / Math.max(0.0001, speed);
      if(window.__playbackState.currentTime === null || window.__playbackState.currentTime === undefined) window.__playbackState.currentTime = window.__playbackState.globalMin || 0;
      acc += dt;
      if(acc >= stepDelay){ const steps = Math.floor(acc/stepDelay); acc -= steps*stepDelay; window.__playbackState.currentTime = Math.min(window.__playbackState.globalMax||Infinity, (window.__playbackState.currentTime||0) + steps * unit); updatePlaybackForTime(window.__playbackState.currentTime); if(window.__playbackState.currentTime >= window.__playbackState.globalMax) window.__playbackState.playing = false; }
    }
    window.__playbackState.rafId = requestAnimationFrame(loop);
  }
  window.__playbackState.rafId = requestAnimationFrame(loop);
}

function stopPlaybackLoop(){ if(window.__playbackState.rafId){ cancelAnimationFrame(window.__playbackState.rafId); window.__playbackState.rafId = null; } }

function showPlaybackBar(){
  if(window.__playbackUI) { window.__playbackUI.style.display='flex'; return; }
  const bar = document.createElement('div'); bar.className = 'playback-bar';
  bar.innerHTML = `
    <div class="playback-controls">
      <button class="pb-btn" style="font-weight: 900;" id="pb-begin"><<</button>
      <button class="pb-btn" style="font-weight: 900;" id="pb-rewind"><</button>
      <button class="pb-btn" id="pb-play">▶</button>
      <button class="pb-btn" id="pb-stop">■</button>
      <button class="pb-btn" style="font-weight: 900;" id="pb-forward">></button>
      <button class="pb-btn" style="font-weight: 900;" id="pb-end">>></button>
    </div>
    <div class="pb-time" id="pb-time">—</div>
    <div class="pb-timeline"><canvas id="pb-canvas" class="pb-canvas"></canvas></div>
    <div class="pb-speed" id="pb-speed"><label style="margin-right:8px;color:var(--muted)">Speed:</label><span id="pb-speed-label">10×</span><input id="pb-speed-range" type="range" min="1" max="50" step="1" value="10" style="margin-left:8px;width:120px" /><button class="pb-btn" id="pb-exit" title="Exit playback" style="margin-left:8px">✖</button></div>
  `;
  document.body.appendChild(bar); window.__playbackUI = bar;
  document.getElementById('pb-play').addEventListener('click', async ()=>{
    window.__playbackState.playing = !window.__playbackState.playing;
    document.getElementById('pb-play').textContent = window.__playbackState.playing ? '❚❚' : '▶';
    if(window.__playbackState.playing) startPlaybackLoop(); else stopPlaybackLoop();
  });
  document.getElementById('pb-stop').addEventListener('click', ()=>{ window.__playbackState.playing = false; stopPlaybackLoop(); window.__playbackState.currentTime = window.__playbackState.globalMin; updatePlaybackForTime(window.__playbackState.currentTime); });
  const speedRange = bar.querySelector('#pb-speed-range'); const speedLabel = bar.querySelector('#pb-speed-label');
  if(speedRange){ speedRange.addEventListener('input', ()=>{ const sp = Math.max(1, Math.min(50, Number(speedRange.value)||1)); window.__playbackState.speed = sp; speedLabel.textContent = sp + '×'; }); const initSp = Number(speedRange.value)||1; window.__playbackState.speed = initSp; speedLabel.textContent = initSp + '×'; }
  document.getElementById('pb-exit').addEventListener('click', ()=>{ hidePlaybackBar(); try{ window.__playbackLayer.clearLayers(); window.__playbackTracks = {}; }catch(e){} stopPlaybackLoop(); window.__playbackState.playing=false; try{ restoreShipsAfterPlayback(); }catch(e){} });
}

function hidePlaybackBar(){ if(window.__playbackUI){ try{ window.__playbackUI.style.display='none'; }catch(e){} } }

// restore ship markers when exiting playback mode
function restoreShipsAfterPlayback(){
  try{
    window.__playbackModeActive = false;
    // repopulate markers according to current filters/search
    const q = (typeof searchEl !== 'undefined' && searchEl) ? searchEl.value.trim().toLowerCase() : '';
    filterShips(q, false);
  }catch(e){ console.debug('restoreShipsAfterPlayback failed', e); }
}

// get last timestamp for a ship item (seconds)
function getItemLastTimestamp(item){
  if(!item) return null;
  const candidates = [item.TIMESTAMP, item.timestamp, item.time, item.updated_at, item.updatedAt, item.Time, item.last_seen, item.lastSeen];
  for(const c of candidates){
    const ts = parsePointTimestamp(c);
    if(ts) return ts;
  }
  return null;
}

// Update inactive markers based on legend control and slider
function updateInactiveMarkers(){
  try{
    const chk = document.getElementById('filterInactive');
    const slider = document.getElementById('inactiveDays');
    if(!chk || !slider) return;
    const active = !!chk.checked;
    const days = Math.max(1, Math.min(30, Number(slider.value)||7));
    const now = (window.__playbackState && window.__playbackState.currentTime) ? window.__playbackState.currentTime : Math.floor(Date.now()/1000);
    const threshold = now - days * 24 * 3600;
    markers.forEach(m=>{
      try{
        const item = m.item;
        // skip certain ship types (Law Enforcement or Military Ops)
        const st = (item && (item.SHIPTYPE || item.ShipType || item.shiptype || item.TYPE || item.type || item.CLASS)) ? String(item.SHIPTYPE || item.ShipType || item.shiptype || item.TYPE || item.type || item.CLASS) : '';
        if(st && /law enforcement|military ops|military/i.test(st)){
          // ensure ring not shown
          try{ const el = (m.marker && m.marker.getElement) ? m.marker.getElement() : null; if(el){ const wrap = el.querySelector('.ship-marker-wrap'); if(wrap) wrap.classList.remove('inactive'); } }catch(e){}
          return;
        }
        const last = getItemLastTimestamp(item);
        const el = (m.marker && m.marker.getElement) ? m.marker.getElement() : null;
        if(!el) return;
        const wrap = el.querySelector('.ship-marker-wrap');
        if(!wrap) return;
        if(active && last !== null && last <= threshold){
          wrap.classList.add('inactive');
        } else {
          wrap.classList.remove('inactive');
        }
      }catch(e){}
    });
  }catch(e){ console.debug('updateInactiveMarkers failed', e); }
}

function enterPlaybackMode(keys){
  if(!Array.isArray(keys)) keys = [];
  window.__playbackSelectedKeys = keys.map(String);
  // hide non-selected ships in the main marker layer
  try{
    window.__playbackModeActive = true;
    const sel = new Set(window.__playbackSelectedKeys.map(String));
    markers.forEach(m=>{
      try{
        const key = String(getShipPlaybackKey(m.item)||'');
        if(!sel.has(key)){
          try{ markerGroup.removeLayer(m.marker); }catch(e){}
        } else {
          try{ markerGroup.addLayer(m.marker); }catch(e){}
        }
      }catch(e){}
    });
  }catch(e){}
  loadTracksForKeys(window.__playbackSelectedKeys);
}

window.enterPlaybackMode = enterPlaybackMode;

// Helper: determine best key to identify a ship for tracks
function getShipPlaybackKey(item){
  if(!item) return null;
  return item.SHIP_ID || item.shipid || item.IMO || item.imo || item.MMSI || item.mmsi || null;
}

// Playback selection modal
function openPlaybackModal(){
  const overlay = document.createElement('div'); overlay.className = 'playback-modal-overlay';
  const modal = document.createElement('div'); modal.className = 'playback-modal';
  const head = document.createElement('div'); head.className = 'modal-head';
  const title = document.createElement('h3'); title.textContent = 'Select vessels for playback'; head.appendChild(title);
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '✕'; close.addEventListener('click', ()=>{ document.body.removeChild(overlay); document.body.removeChild(modal); }); head.appendChild(close);
  modal.appendChild(head);
  const body = document.createElement('div'); body.className = 'modal-body';
  const search = document.createElement('input'); search.type='search'; search.placeholder='Filter ships...'; search.style.width='100%'; search.style.marginBottom='8px'; body.appendChild(search);
  // show currently selected vessels (from Add-to-playback) as a single-line summary
  const selLine = document.createElement('div'); selLine.className = 'pb-selected'; selLine.style.marginBottom = '6px'; selLine.style.fontSize = '13px'; selLine.style.color = 'var(--muted)';
  try{
  let sel = Array.isArray(window.__playbackSelectedKeys) ? window.__playbackSelectedKeys.map(String) : [];
    const names = [];
    if(sel && sel.length){
      for(const k of sel){ try{ const s = allShips.find(x=>String(getShipPlaybackKey(x))===String(k)); names.push(s ? (s.SHIPNAME||s.name||String(k)) : String(k)); }catch(e){}
      }
    }
    selLine.textContent = names.length ? names.join(', ') : 'No vessels selected';
  }catch(e){ selLine.textContent = 'No vessels selected'; }
  body.appendChild(selLine);
  const list = document.createElement('div'); list.style.maxHeight='56vh'; list.style.overflow='auto'; list.style.paddingRight='6px';
  // populate list from allShips
  const rows = [];
  allShips.forEach(it=>{
    const key = getShipPlaybackKey(it);
    if(!key) return;
    const label = (it.SHIPNAME || it.name || key).toString();
    const row = document.createElement('label'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px'; row.style.padding='4px 6px';
    const cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.key = String(key);
      try{
      // pre-check if this ship is already in the playback selection (in-memory only)
      let sel = Array.isArray(window.__playbackSelectedKeys) ? window.__playbackSelectedKeys.map(String) : [];
      if(sel && sel.indexOf(String(key)) !== -1) cb.checked = true;
    }catch(e){}
    const span = document.createElement('span'); span.textContent = label + (it.FLAG ? ' — ' + it.FLAG : ''); span.style.color='var(--muted)';
    row.appendChild(cb); row.appendChild(span);
    list.appendChild(row); rows.push({row, label: label.toLowerCase()});
  });
  body.appendChild(list);
  modal.appendChild(body);
  const actions = document.createElement('div'); actions.className = 'playback-actions';
  const selectAll = document.createElement('button'); selectAll.textContent='Select all'; selectAll.className='pb-btn'; selectAll.addEventListener('click', ()=>{ list.querySelectorAll('input[type=checkbox]').forEach(i=>i.checked=true); });
  const clear = document.createElement('button'); clear.textContent='Clear'; clear.className='pb-btn'; clear.addEventListener('click', ()=>{
    list.querySelectorAll('input[type=checkbox]').forEach(i=>i.checked=false);
    // clear in-memory selection and update UI
    try{ window.__playbackSelectedKeys = []; }catch(e){}
    try{ selLine.textContent = 'No vessels selected'; }catch(e){}
    try{ const b = document.getElementById('addToPlaybackBtn'); if(b) b.textContent = 'Add to playback'; }catch(e){}
  });
  const start = document.createElement('button'); start.textContent='Start playback'; start.className='pb-btn'; start.addEventListener('click', ()=>{
    const keys = Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(i=>i.dataset.key).filter(Boolean);
    if(keys.length===0){ alert('Select at least one vessel'); return; }
    enterPlaybackMode(keys);
    showPlaybackBar();
    document.body.removeChild(overlay); document.body.removeChild(modal);
  });
  actions.appendChild(selectAll); actions.appendChild(clear); actions.appendChild(start);
  modal.appendChild(actions);
  document.body.appendChild(overlay); document.body.appendChild(modal);
  // simple filtering
  search.addEventListener('input', ()=>{
    const q = search.value.trim().toLowerCase();
    rows.forEach(r=>{ r.row.style.display = (!q || r.label.indexOf(q)!==-1) ? 'flex' : 'none'; });
  });
}

// expose modal and playback UI helpers globally
try{ window.openPlaybackModal = openPlaybackModal; }catch(e){}
try{ window.showPlaybackBar = showPlaybackBar; window.hidePlaybackBar = hidePlaybackBar; }catch(e){}

// Ensure topbar playback button is wired even if DOM wasn't ready earlier
function wirePlaybackTopButtonOnce(){
  try{
    const topControls = document.querySelector('.topbar .controls');
    if(!topControls) return false;
    if(document.getElementById('playbackTopBtn')) return true;
    const pbTop = document.createElement('button');
    pbTop.id = 'playbackTopBtn'; pbTop.textContent = 'Playback'; pbTop.title = 'Open playback selection';
    try{
      // Prefer inserting before the RAW data button so Playback sits with other buttons
      const rawBtnEl = document.getElementById('rawBtn');
      if(rawBtnEl && rawBtnEl.parentNode === topControls){ topControls.insertBefore(pbTop, rawBtnEl); }
      else if(statsBtn && statsBtn.parentNode === topControls){ topControls.insertBefore(pbTop, statsBtn.nextSibling); }
      else { topControls.appendChild(pbTop); }
    }catch(e){ topControls.appendChild(pbTop); }
    pbTop.addEventListener('click', ()=>{ try{ openPlaybackModal(); }catch(e){ console.debug('openPlaybackModal failed', e); } });
    return true;
  }catch(e){ return false; }
}
if(!wirePlaybackTopButtonOnce()){
  window.addEventListener('DOMContentLoaded', ()=>{ wirePlaybackTopButtonOnce(); });
  setTimeout(()=>{ wirePlaybackTopButtonOnce(); }, 1500);
}

// end playback subsystem
window.setDarkMode = setDarkMode;

const sidebar = document.getElementById('sidebar');
const closeBtn = document.getElementById('closeSidebar');
const shipNameEl = document.getElementById('shipName');
const shipMetaEl = document.getElementById('shipMeta');
const linksEl = document.getElementById('links');
const shipImageEl = document.getElementById('shipImage');
const searchEl = document.getElementById('search');
const statsBtn = document.getElementById('statsBtn');
const lastUpdatedEl = document.getElementById('lastUpdated');

closeBtn.addEventListener('click', ()=>{ sidebar.classList.remove('open'); });

let allShips = [];
let markers = [];
const markerGroup = L.featureGroup().addTo(map);
// visibility state for toggles
window.__shipsVisible = true;
window.__portsVisible = true;
window.__militaryVisible = true;
window.__lawVisible = true;

// dedicated layers for military and law-enforcement vessels
window.__militaryLayer = L.layerGroup();
window.__lawLayer = L.layerGroup();
window.__onlyShowCategories = false;

// Ensure a globally-available weight/size helper is defined early so
// other functions (which may execute on load) can call it without
// depending on script load order or different dev servers.
function getWeightInfo(it){
  const keys = ['DWT','dwt','GT','GRT','gt','GRT','WEIGHT','weight','LENGTH','length','LENGTH_METERS','GRT'];
  let keyFound = null;
  let val = null;
  for(const k of keys){
    if(it && it[k]!==undefined && it[k]!==null){
      const num = parseFloat(it[k]);
      if(Number.isFinite(num)){
        keyFound = k;
        val = num;
        break;
      }
    }
  }
  const buckets = {small:{color:'#16a34a',size:20,label:'Small'}, medium:{color:'#f59e0b',size:28,label:'Medium'}, large:{color:'#ef4444',size:36,label:'Large'}};
  if(!keyFound) return {key:null,value:null, bucket:'small', color:buckets.small.color, size:buckets.small.size, label:buckets.small.label};
  const k = keyFound.toUpperCase();
  if(['DWT','DWT_MT'].includes(k)){
    if(val < 5000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:'<5000 DWT'};
    if(val < 20000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:'5k-20k DWT'};
    return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:'>20k DWT'};
  }
  if(['GT','GRT'].includes(k)){
    if(val < 1000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:'<1k GT'};
    if(val < 10000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:'1k-10k GT'};
    return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:'>10k GT'};
  }
  if(k === 'LENGTH'){
    if(val < 80) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:18,label:'<80 m'};
    if(val < 180) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:26,label:'80-180 m'};
    return {key:k,value:val,bucket:'large',color:buckets.large.color,size:34,label:'>180 m'};
  }
  return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label: String(val)};
}

// set visibility for military / law enforcement categories
function setMilitaryVisible(show){
  window.__militaryVisible = !!show;
  try{ const q = searchEl.value.trim().toLowerCase(); filterShips(q, false); }catch(e){}
}
function setLawVisible(show){
  window.__lawVisible = !!show;
  try{ const q = searchEl.value.trim().toLowerCase(); filterShips(q, false); }catch(e){}
}
window.setMilitaryVisible = setMilitaryVisible;
window.setLawVisible = setLawVisible;

function setShipsVisible(show){
  window.__shipsVisible = !!show;
  try{
    // reapply current search filter without changing view; do not remove the markerGroup layer entirely
    const q = searchEl.value.trim().toLowerCase();
    filterShips(q, false);
    if(!map.hasLayer(markerGroup)) map.addLayer(markerGroup);
  }catch(e){ console.debug('setShipsVisible error', e); }
}

function setPortsVisible(show){
  window.__portsVisible = !!show;
  try{
    if(window.__portsVisible){
      // repopulate ports layer based on current search
      const q = searchEl.value.trim().toLowerCase();
      if(window.__portsMarkers){
        window.__portsLayer.clearLayers();
        window.__portsMarkers.forEach(pm=>{
          const name = (pm.feature && pm.feature.properties && pm.feature.properties.name) ? String(pm.feature.properties.name).toLowerCase() : '';
          if(!q || name.indexOf(q) !== -1) window.__portsLayer.addLayer(pm.marker);
        });
      }
      if(window.__portsLayer && !map.hasLayer(window.__portsLayer)) map.addLayer(window.__portsLayer);
    } else {
      if(window.__portsLayer && map.hasLayer(window.__portsLayer)) map.removeLayer(window.__portsLayer);
    }
  }catch(e){ console.debug('setPortsVisible error', e); }
}

// Expose for external scripts and legacy UI ids
window.setShipsVisible = setShipsVisible;
window.setPortsVisible = setPortsVisible;

// Wire common toggle checkbox IDs to the toggle handlers so toggles work
function wireVisibilityToggles(){
  const shipIds = ['filterShips','toggleShips'];
  const portIds = ['filterPorts','togglePorts'];
  const militaryIds = ['filterMilitary'];
  const lawIds = ['filterLaw'];
  const onlyCatIds = ['filterOnlyCategories'];
  shipIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    // keep checkbox in sync
    try{ el.checked = !!window.__shipsVisible; }catch(e){}
    el.removeEventListener('change', el._sf_change_handler);
    const handler = function(e){ setShipsVisible(e.target.checked); };
    el.addEventListener('change', handler);
    el._sf_change_handler = handler;
  });
  portIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    try{ el.checked = !!window.__portsVisible; }catch(e){}
    el.removeEventListener('change', el._pf_change_handler);
    const handler = function(e){ setPortsVisible(e.target.checked); };
    el.addEventListener('change', handler);
    el._pf_change_handler = handler;
  });
  militaryIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    try{ el.checked = !!window.__militaryVisible; }catch(e){}
    el.removeEventListener('change', el._mil_change_handler);
    const handler = function(e){ setMilitaryVisible(e.target.checked); };
    el.addEventListener('change', handler);
    el._mil_change_handler = handler;
  });
  lawIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    try{ el.checked = !!window.__lawVisible; }catch(e){}
    el.removeEventListener('change', el._law_change_handler);
    const handler = function(e){ setLawVisible(e.target.checked); };
    el.addEventListener('change', handler);
    el._law_change_handler = handler;
  });
  // dark mode toggle wiring
  const darkIds = ['toggleDarkMode'];
  darkIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    try{ el.checked = !!window.__darkMode; }catch(e){}
    el.removeEventListener('change', el._dm_change_handler);
    const handler = function(e){ setDarkMode(!!e.target.checked); };
    el.addEventListener('change', handler);
    el._dm_change_handler = handler;
  });
  onlyCatIds.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    try{ el.checked = !!window.__onlyShowCategories; }catch(e){}
    el.removeEventListener('change', el._only_change_handler);
    const handler = function(e){ window.__onlyShowCategories = !!e.target.checked; const q = searchEl.value.trim().toLowerCase(); filterShips(q, false); };
    el.addEventListener('change', handler);
    el._only_change_handler = handler;
  });
}

// attempt to wire immediately and also after legend creation
try{ wireVisibilityToggles(); }catch(e){ console.debug('wireVisibilityToggles initial failed', e); }

searchEl.addEventListener('input', ()=>{
  const q = searchEl.value.trim().toLowerCase();
  filterShips(q);
  filterPorts(q);
});

statsBtn.addEventListener('click', ()=>{
  openStatsModal('flag');
});

// add Playback button to the topbar next to Flag Stats
try{
  const topControls = document.querySelector('.topbar .controls');
  if(topControls){
    let pbTop = document.getElementById('playbackTopBtn');
    if(!pbTop){
      pbTop = document.createElement('button');
      pbTop.id = 'playbackTopBtn';
      pbTop.textContent = 'Playback';
      pbTop.title = 'Open playback selection';
      // insert before statsBtn if present, else append
      try{ if(statsBtn && statsBtn.parentNode === topControls) topControls.insertBefore(pbTop, statsBtn.nextSibling); else topControls.appendChild(pbTop); }catch(e){ topControls.appendChild(pbTop); }
      pbTop.addEventListener('click', ()=>{ try{ openPlaybackModal(); }catch(e){ console.debug('openPlaybackModal failed', e); } });
    }
  }
}catch(e){ console.debug('adding topbar playback button failed', e); }

const rawBtn = document.getElementById('rawBtn');
if(rawBtn){ rawBtn.addEventListener('click', ()=> window.open('ships.json','_blank')); }

function showDetails(data){
  shipNameEl.textContent = data.SHIPNAME || data.name || `Ship ${data.SHIP_ID||data.shipid||''}`;
  // set image placeholder and try to load from data or vessel finder
  shipImageEl.innerHTML = '';
  const imgUrlFromData = data.image || data.imageUrl || data.image_url || data.img;
  if(imgUrlFromData){
    const img = document.createElement('img'); img.src = imgUrlFromData; img.alt = data.SHIPNAME || '';
    shipImageEl.appendChild(img);
    // add credit/link under image
    const credit = document.createElement('div'); credit.className = 'image-credit';
    const creditLink = document.createElement('a'); creditLink.href = img.src; creditLink.target = '_blank'; creditLink.rel = 'noopener noreferrer'; creditLink.textContent = '© vesselfinder.com';
    credit.appendChild(creditLink);
    shipImageEl.appendChild(credit);
  } else {
    // show a small spinner while fetching
    const spinner = document.createElement('div'); spinner.textContent = 'Loading image…'; spinner.style.color='var(--muted)'; shipImageEl.appendChild(spinner);
    const imo = data.IMO || data.imo || null;
    if(imo){
      fetchVesselfinderImage(imo).then(src=>{
        shipImageEl.innerHTML = '';
        if(src){
          const img = document.createElement('img'); img.src = src; img.alt = data.SHIPNAME || '';
          shipImageEl.appendChild(img);
          // add credit/link under fetched image
          const credit = document.createElement('div'); credit.className = 'image-credit';
          const creditLink = document.createElement('a'); creditLink.href = src; creditLink.target = '_blank'; creditLink.rel = 'noopener noreferrer'; creditLink.textContent = '© vesselfinder.com';
          credit.appendChild(creditLink);
          shipImageEl.appendChild(credit);
        }
      }).catch(()=>{ shipImageEl.innerHTML = ''; });
    } else {
      shipImageEl.innerHTML = '';
    }
  }

  // build metadata (SHIPTYPE already mapped in ships.json)
  const lines = [];
  // show numeric/location/etc fields except MMSI/IMO which we render explicitly below
  for(const k of ['LAT','LON','SPEED','HEADING','COURSE','SHIPTYPE','LENGTH','WIDTH','FLAG','TIMESTAMP']){
    if(data[k]!==undefined && data[k]!==null){
      let value = data[k];
      if(k === 'SHIPTYPE' && (value === undefined || value === null || value === '')){
        value = 'UNKNOWN';
      }
      lines.push(`<div><strong>${k}:</strong> ${escapeHtml(value)}</div>`);
    }
  }
  // render MMSI then IMO directly under it (check common key variants)
  const mmsiVal = data.MMSI || data.mmsi || data.Mmsi || data.mmsi_number || null;
  if(mmsiVal !== undefined && mmsiVal !== null && mmsiVal !== ''){
    lines.unshift(`<div><strong>MMSI:</strong> ${escapeHtml(mmsiVal)}</div>`);
  }
  const imoVal = data.IMO || data.imo || data.Imo || data.imo_number || null;
  if(imoVal !== undefined && imoVal !== null && imoVal !== ''){
    // place IMO right after MMSI if MMSI present, otherwise at top
    if(mmsiVal){
      // insert after first element
      if(lines.length>0){
        lines.splice(1,0,`<div><strong>IMO:</strong> ${escapeHtml(imoVal)}</div>`);
      } else {
        lines.push(`<div><strong>IMO:</strong> ${escapeHtml(imoVal)}</div>`);
      }
    } else {
      lines.unshift(`<div><strong>IMO:</strong> ${escapeHtml(imoVal)}</div>`);
    }
  }
  shipMetaEl.innerHTML = lines.join('');
  // append seized status (show True in bold red)
  const seizedHtml = data.seized ? `<div><strong>Seized:</strong> <strong style="color:#ef4444">True</strong></div>` : `<div><strong>Seized:</strong> False</div>`;
  shipMetaEl.innerHTML += seizedHtml;

  // render notes (markdown) into the dedicated notes container
  const shipNotesEl = document.getElementById('shipNotes');
  if(shipNotesEl){
    const notesRaw = (data.notes || '').toString();
    if(notesRaw.trim()) shipNotesEl.innerHTML = renderMarkdown(notesRaw);
    else shipNotesEl.innerHTML = '<div class="notes-empty">—</div>';
  }

  // links
  const shipid = data.SHIP_ID || data.shipid || '';
  const imo = data.IMO || data.imo || '';
  const vesselName = (data.SHIPNAME || data.name || '').toString().trim();
  linksEl.innerHTML = '';
  // favicon sources
  const favicons = {
    ecosia: 'assets/ecosia.ico',
    marinetraffic: 'assets/marinetraffic.ico',
    vesselfinder: 'assets/vesselfinder.ico',
    opensanctions: 'assets/opensanctions.png',
    war: 'assets/warsanctions.svg',
    militarnyi: 'assets/militarnyi.png',
    maritimeoptima: 'assets/maritimeoptima.png'
  };

  const linkSpecs = [];
  linkSpecs.push({href:`https://www.marinetraffic.com/en/ais/details/ships/shipid:${shipid}#overview`, title:'Marinetraffic', domain:'marinetraffic.com', icon:favicons.marinetraffic});
  linkSpecs.push({href:`https://www.vesselfinder.com/vessels/details/${imo}`, title:'Vesselfinder', domain:'vesselfinder.com', icon:favicons.vesselfinder});
  // use the search endpoint which accepts IMO via `q` parameter
  linkSpecs.push({href:`https://war-sanctions.gur.gov.ua/en/search/index?q=${encodeURIComponent(imo)}`, title:'War Sanctions', domain:'war-sanctions.gur.gov.ua', icon:favicons.war});

  // Ecosia search for vessel name
  if(vesselName){
    const q = `"shadow fleet" "russia" "${vesselName.toLowerCase()}"`;
    const ecosiaUrl = `https://www.ecosia.org/search?method=index&q=${encodeURIComponent(q)}`;
    linkSpecs.push({href:ecosiaUrl, title:'Ecosia', domain:'ecosia.org', icon:favicons.ecosia});

    const militUrl = `https://www.ecosia.org/search?method=index&q=${encodeURIComponent(`site:militarnyi.com "${vesselName}"` )}`;
    linkSpecs.push({href:militUrl, title:'Militarnyi', domain:'militarnyi.com', icon:favicons.militarnyi});

    const marUrl = `https://www.ecosia.org/search?q=${encodeURIComponent(`site:maritimeoptima.com "maritime-news" "${vesselName}"`)}`;
    linkSpecs.push({href:marUrl, title:'MaritimeOptima', domain:'maritimeoptima.com', icon:favicons.maritimeoptima});
  }

  if(imo){
    const opensanctionsUrl = `https://www.opensanctions.org/search/?q=${encodeURIComponent('IMO'+imo)}`;
    linkSpecs.push({href:opensanctionsUrl, title:'Opensanctions', domain:'opensanctions.org', icon:favicons.opensanctions});
  }

  // render as icon links
  for(const spec of linkSpecs){
    const li = document.createElement('li'); li.className = 'fav-link-item';
    const a = document.createElement('a'); a.href = spec.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'fav-link';
    const img = document.createElement('img'); img.src = spec.icon; img.alt = spec.title + ' icon'; img.className = 'fav-icon';
    const span = document.createElement('span'); span.className = 'fav-domain'; span.textContent = spec.domain || spec.title;
    a.appendChild(img); a.appendChild(span); li.appendChild(a); linksEl.appendChild(li);
  }

  
  
    // add track toggle button
    let trackBtn = document.getElementById('trackToggleBtn');
    if(!trackBtn){
      trackBtn = document.createElement('button');
      trackBtn.id = 'trackToggleBtn';
      trackBtn.className = 'track-toggle';
      trackBtn.textContent = 'Show track';
      trackBtn.type = 'button';
      // insert before Links header
      const linksHeader = document.querySelector('#sidebar h3');
      if(linksHeader && linksHeader.parentNode){
        linksHeader.parentNode.insertBefore(trackBtn, linksHeader);
      } else {
        // fallback append
        linksEl.parentNode.insertBefore(trackBtn, linksEl);
      }
    }
    // set data-shipid and data-imo for this button
    trackBtn.dataset.shipid = shipid;
    trackBtn.dataset.imo = imo;
    trackBtn.textContent = (window.__trackVisible && window.__trackShipId == shipid) ? 'Hide track' : 'Show track';
    trackBtn.onclick = async function(){
      const sid = this.dataset.shipid;
      const simo = this.dataset.imo;
      if(window.__trackVisible && window.__trackShipId == sid){
        // hide
        removeTrackLayer();
        this.textContent = 'Show track';
        return;
      }
      // show (load track)
      this.textContent = 'Loading track...';
      try{
        await showTrackForShip(sid, simo);
        this.textContent = 'Hide track';
      }catch(e){
        console.error('Failed to load track', e);
        this.textContent = 'Show track';
        alert('Failed to load track for this ship.');
      }
    };

    // add "Add to playback" button (placed next to track button)
    let addPbBtn = document.getElementById('addToPlaybackBtn');
    if(!addPbBtn){
      addPbBtn = document.createElement('button');
      addPbBtn.id = 'addToPlaybackBtn';
      addPbBtn.className = 'track-toggle';
      addPbBtn.type = 'button';
      addPbBtn.textContent = 'Add to playback';
      if(trackBtn && trackBtn.parentNode) trackBtn.parentNode.insertBefore(addPbBtn, trackBtn.nextSibling);
      else if(linksEl && linksEl.parentNode) linksEl.parentNode.insertBefore(addPbBtn, linksEl);
    }
    // wire Add to playback button
    try{
      const addBtn = document.getElementById('addToPlaybackBtn');
      if(addBtn){
          addBtn.dataset.shipid = shipid;
          addBtn.dataset.imo = imo;
          // set initial text based on current selection
          try{
            const sel = Array.isArray(window.__playbackSelectedKeys) ? window.__playbackSelectedKeys.map(String) : [];
            const keyStr = String(data.SHIP_ID || data.shipid || data.IMO || data.imo || data.MMSI || data.mmsi || '');
            if(sel.indexOf(keyStr) !== -1) addBtn.textContent = 'Remove from playback'; else addBtn.textContent = 'Add to playback';
          }catch(e){}
          addBtn.onclick = async function(){
            const key = (data.SHIP_ID || data.shipid || data.IMO || data.imo || data.MMSI || data.mmsi || null);
            if(!key){ alert('This vessel has no usable ID for playback'); return; }
            try{
              if(!Array.isArray(window.__playbackSelectedKeys)) window.__playbackSelectedKeys = [];
              const existing = window.__playbackSelectedKeys.map(String);
              const keyStr = String(key);
              if(existing.indexOf(keyStr) !== -1){
                // remove
                window.__playbackSelectedKeys = existing.filter(x=>x!==keyStr);
                this.textContent = 'Add to playback';
              } else {
                // add
                window.__playbackSelectedKeys = Array.from(new Set([...existing, keyStr]));
                this.textContent = 'Remove from playback';
              }
              // do not persist selection to localStorage by design
            }catch(e){ console.debug('Add to playback failed', e); alert('Failed to toggle vessel for playback'); }
          };
      }
    }catch(e){ console.debug('wiring addToPlaybackBtn failed', e); }

    sidebar.classList.add('open');
}

// Minimal safe-ish markdown renderer for notes (supports headings, bold, italic, links, inline code, lists, code blocks)
function renderMarkdown(md){
  // escape first
  let out = escapeHtml(md);
  // code blocks ```...```
  out = out.replace(/```([\s\S]*?)```/g, function(_, code){ return `<pre class="md-code">${escapeHtml(code)}</pre>`; });
  // inline code `...`
  out = out.replace(/`([^`]+)`/g, function(_, c){ return `<code class="md-inline">${escapeHtml(c)}</code>`; });
  // bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic *text*
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, t, u){ return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`; });
  // lists: lines starting with - or *
  const lines = out.split(/\r?\n/);
  let res = [];
  let inList = false;
  for(const line of lines){
    const l = line.trim();
    const m = l.match(/^[-*]\s+(.*)/);
    if(m){
      if(!inList){ res.push('<ul class="md-list">'); inList = true; }
      res.push(`<li>${m[1]}</li>`);
    } else {
      if(inList){ res.push('</ul>'); inList = false; }
      if(l === '') res.push('<p></p>'); else res.push(`<p>${l}</p>`);
    }
  }
  if(inList) res.push('</ul>');
  return res.join('\n');
}


async function fetchVesselfinderImage(imo){

  // First try a local proxy (see proxy.py) to avoid CORS issues.

  // Extracted helper: determine weight/size bucket and default color/size
  function getWeightInfo(it){
    const keys = ['DWT','dwt','GT','GRT','gt','GRT','WEIGHT','weight','LENGTH','length','LENGTH_METERS','GRT'];
    let keyFound = null;
    let val = null;
    for(const k of keys){
      if(it[k]!==undefined && it[k]!==null){
        const num = parseFloat(it[k]);
        if(Number.isFinite(num)){
          keyFound = k;
          val = num;
          break;
        }
      }
    }
    const buckets = {small:{color:'#16a34a',size:20,label:'Small'}, medium:{color:'#f59e0b',size:28,label:'Medium'}, large:{color:'#ef4444',size:36,label:'Large'}};
    if(!keyFound) return {key:null,value:null, bucket:'small', color:buckets.small.color, size:buckets.small.size, label:buckets.small.label};
    const k = keyFound.toUpperCase();
    if(['DWT','DWT_MT'].includes(k)){
      if(val < 5000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:'<5000 DWT'};
      if(val < 20000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:'5k-20k DWT'};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:'>20k DWT'};
    }
    if(['GT','GRT'].includes(k)){
      if(val < 1000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:'<1k GT'};
      if(val < 10000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:'1k-10k GT'};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:'>10k GT'};
    }
    if(k === 'LENGTH'){
      if(val < 80) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:18,label:'<80 m'};
      if(val < 180) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:26,label:'80-180 m'};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:34,label:'>180 m'};
    }
    return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label: String(val)};
  }
  try{
    const proxyUrl = `http://127.0.0.1:8001/vesselfinder/${imo}`;
    const r = await fetch(proxyUrl);
    if(r.ok){
      const j = await r.json();
      if(j.image) return j.image;
    }
  }catch(e){
    console.debug('proxy fetch failed', e);
  }

  // Fallback: attempt direct fetch (likely blocked by CORS in the browser)
  try{
    const resp = await fetch(`https://www.vesselfinder.com/vessels/details/${imo}`);
    const txt = await resp.text();
    const m = txt.match(/<img[^>]*class=["']main-photo["'][^>]*src=["']([^"']+)["']/i);
    if(m) return m[1];
  }catch(e){
    console.debug('fetchVesselfinderImage failed', e);
  }
  return null;
}

function makeLabelIcon(item, colorOverride){
  // item may contain heading and label fields
  const label = item.SHIPNAME || item.name || item.SHIP_ID || item.shipid || '';
  let heading = null;
  for(const k of ['HEADING','heading','Heading']){
    if(item[k]!==undefined && item[k]!==null){
      const v = parseFloat(item[k]);
      if(Number.isFinite(v)) { heading = v; break; }
    }
  }
  const winfo = getWeightInfo(item);
  
  if(colorOverride) winfo.color = colorOverride;

  // compute nose position in the SVG (viewBox 0..24, nose at x=20) and rotation origin
  const noseX = Math.round(winfo.size * (20/24));
  // create SVG and apply rotation if heading present
  // Use transform-origin at the nose so rotation keeps the tip anchored
  let rotateStyle = '';
  if (heading !== null) {
    const h = Number(heading) || 0;
    // Convert maritime heading to SVG rotation and correct orientation
    const rot = h + 90; // tweak if needed
    rotateStyle = `transform: rotate(${rot}deg); transform-origin: ${noseX}px ${Math.round(winfo.size/2)}px;`;
  }
  const svg = `
    <svg width="${winfo.size}" height="${winfo.size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="${rotateStyle}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <polygon points="2,12 20,4 20,20" fill="${winfo.color}" filter="url(#shadow)" />
    </svg>`;

  // label HTML
  const labelHtml = label ? `<div class="ship-label-text">${escapeHtml(label)}</div>` : '';

  // compute icon sizing and anchor so the SVG center (nose) aligns with the lat/lon
  const iconWidth = 140; // width reserved for optional label
  const iconHeight = Math.max(winfo.size, 36);
  // anchor at the nose X coordinate so the tip aligns with the geographic point
  const anchorX = noseX;
  const anchorY = Math.round(winfo.size / 2);
  // compute inactive ring placement so it's centered on the anchor point
  const ringSize = Math.max(36, Math.round(winfo.size * 1.6));
  const ringLeft = Math.round(anchorX - (ringSize/2));
  const ringTop = Math.round(anchorY - (ringSize/2));
  const ringStyle = `left:${ringLeft}px;top:${ringTop}px;width:${ringSize}px;height:${ringSize}px;transform:translate(-50%,-50%);`;
  // include inactive ring element (hidden by default) so we can toggle it dynamically
  const html = `<div class="ship-marker-wrap">` +
               `<div class="inactive-ring" aria-hidden="true" style="${ringStyle}"><div class="pulse"></div><div class="dot"></div></div>` +
               `${svg}${labelHtml}</div>`;
  const popupAnchorY = -Math.round(winfo.size / 2) - 4;
  return L.divIcon({
    className: 'ship-marker',
    html: html,
    iconSize: [iconWidth, iconHeight],
    iconAnchor: [anchorX, anchorY],
    popupAnchor: [0, popupAnchorY]
  });
}

// Track handling: show/hide per-ship track loaded from /tracks/<shipid>.json
function removeTrackLayer(){
  if(window.__trackLayer){
    try{ map.removeLayer(window.__trackLayer); }catch(e){}
    try{ map.removeLayer(window.__trackPointsLayer); }catch(e){}
    window.__trackLayer = null; window.__trackPointsLayer = null; window.__trackVisible = false; window.__trackShipId = null;
  }
}

async function showTrackForShip(shipid, imo){
  removeTrackLayer();
  if(!shipid && !imo) throw new Error('no shipid/imo');

  const candidates = [];
  if(shipid) candidates.push(`tracks/${encodeURIComponent(shipid)}.json`);
  if(imo) candidates.push(`tracks/${encodeURIComponent(imo)}.json`);
  // try candidates sequentially
  let r = null; let pts = null; let lastErr = null;
  for(const url of candidates){
    try{
      r = await fetch(url);
    }catch(err){ r = null; lastErr = err; }
    if(!r){ lastErr = lastErr || new Error('no response'); continue; }
    if(!r.ok){ lastErr = new Error('HTTP ' + r.status); continue; }
    try{ pts = await r.json(); }catch(err){ lastErr = err; pts = null; }
    if(Array.isArray(pts) && pts.length>0){
      break;
    } else {
      lastErr = new Error('no points');
      pts = null;
    }
  }
  if(!pts) throw new Error((lastErr && lastErr.message) ? (lastErr.message + ' — tried: ' + candidates.join(', ')) : ('Failed to load track — tried: ' + candidates.join(', ')));
  if(!Array.isArray(pts) || pts.length === 0) throw new Error('no points');
  const latlngs = pts.map(p=>[parseFloat(p.lat), parseFloat(p.lon)]).filter(ll=>Number.isFinite(ll[0]) && Number.isFinite(ll[1]));
  if(latlngs.length === 0) throw new Error('no valid points');
  // create polyline
  const poly = L.polyline(latlngs, {color:'#ff7800', weight:3, opacity:0.9}).addTo(map);
  // create small circle markers with hover tooltips
  const pointsLayer = L.layerGroup();
  for(let i=0;i<pts.length;i++){
    const p = pts[i];
    const lat = parseFloat(p.lat); const lon = parseFloat(p.lon);
    if(!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const marker = L.circleMarker([lat,lon], {radius:4, fillColor:'#ffb86b', color:'#ff7800', weight:1, fillOpacity:0.9});
    const ts = p.timestamp || p.time || p.t || '';
    marker.bindTooltip(ts || '', {permanent:false, direction:'top', opacity:0.95});
    marker.on('mouseover', function(e){ this.openTooltip(); });
    marker.on('mouseout', function(e){ this.closeTooltip(); });
    pointsLayer.addLayer(marker);
  }
  pointsLayer.addTo(map);
  // store references
  window.__trackLayer = poly;
  window.__trackPointsLayer = pointsLayer;
  window.__trackVisible = true;
  window.__trackShipId = shipid;
  // Do not change map view or zoom when showing tracks — leave user's view intact.
}

// Inject a legend explaining weight buckets
function ensureLegend(){
  if(document.getElementById('map-legend')){
    // If legend exists but the mooring log wasn't present (older runs), recreate it so logs can be appended
    try{
      if(!document.getElementById('mooringLog')){
        const legend = document.getElementById('map-legend');
        const log = document.createElement('div'); log.id = 'mooringLog'; log.className = 'map-log';
        legend.appendChild(log);
      }
    }catch(e){}
    return;
  }
  const legend = document.createElement('div'); legend.id = 'map-legend'; legend.className = 'map-legend';
  legend.innerHTML = `
    <div class="legend-row"><label class="ports-filter-label"><input type="checkbox" id="filterPorts" checked /> Show ports</label></div>
    <div class="legend-row"><label class="cables-filter-label"><input type="checkbox" id="filterCables" /> <span class="swatch" style="background:#00ff66;margin-right:8px"></span>Submarine cables</label></div>
    <div class="legend-row"><label class="pipelines-filter-label"><input type="checkbox" id="filterPipelines" /> <span class="swatch" style="background:#00e6ff;margin-right:8px"></span>Pipelines</label></div>
    <div class="legend-row"><label class="darkmode-label"><input type="checkbox" id="toggleDarkMode" /> Dark mode</label></div>
    <div class="legend-row"><label class="law-filter-label"><input type="checkbox" id="filterLaw" checked /> <span class="swatch" style="background:#1e40af;margin-right:8px"></span>Law enforcement</label></div>
    <div class="legend-row"><label class="military-filter-label"><input type="checkbox" id="filterMilitary" checked /> <span class="swatch" style="background:#0f766e;margin-right:8px"></span>Military Ops</label></div>
    <div class="legend-row"><label class="ships-filter-label"><input type="checkbox" id="filterShips" checked /> All other vessels</label></div>
    <div class="legend-row"><label class="seized-filter-label"><input type="checkbox" id="filterSeized" /> Show seized only</label></div>
    <div class="legend-title">Size / Weight (length criteria)</div>
    <div class="legend-row"><span class="swatch" style="background:#16a34a"></span><span class="lbl">Small — &lt; 80 m</span></div>
    <div class="legend-row"><span class="swatch" style="background:#f59e0b"></span><span class="lbl">Medium — 80–180 m</span></div>
    <div class="legend-row"><span class="swatch" style="background:#ef4444"></span><span class="lbl">Large — &gt; 180 m</span></div>
    <hr />
  `;
  // insert legend into DOM
  document.body.appendChild(legend);
  // inactive ship controls: toggle + slider (1-30 days) — insert before the <hr> so they sit with other toggles
  try{
    const inactiveRow = document.createElement('div'); inactiveRow.className = 'legend-row';
    inactiveRow.innerHTML = `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="filterInactive" /> Show inactive ships</label>`;
    const inactiveSliderRow = document.createElement('div'); inactiveSliderRow.className = 'legend-row';
    inactiveSliderRow.innerHTML = `<label style="display:flex;align-items:center;gap:8px;width:100%"><span style="color:var(--muted);font-size:12px">Inactivity:</span><input id="inactiveDays" type="range" min="1" max="30" value="7" style="flex:1;margin-left:8px" /><span id="inactiveDaysVal" style="min-width:36px;text-align:right;color:var(--muted)">7d</span></label>`;
    // prefer to place the inactive controls right after the "Show seized only" row
    const seizedLabel = legend.querySelector('.seized-filter-label');
    if(seizedLabel && seizedLabel.parentElement){
      const seizedRow = seizedLabel.parentElement;
      if(seizedRow && seizedRow.parentElement){
        seizedRow.parentElement.insertBefore(inactiveRow, seizedRow.nextSibling);
        seizedRow.parentElement.insertBefore(inactiveSliderRow, inactiveRow.nextSibling);
      } else {
        legend.appendChild(inactiveRow); legend.appendChild(inactiveSliderRow);
      }
    } else {
      const hr = legend.querySelector('hr');
      if(hr){ legend.insertBefore(inactiveRow, hr); legend.insertBefore(inactiveSliderRow, hr); }
      else { legend.appendChild(inactiveRow); legend.appendChild(inactiveSliderRow); }
    }
    // mooring log container (ships moored near ports will be listed here)
    const log = document.createElement('div'); log.id = 'mooringLog'; log.className = 'map-log';
    legend.appendChild(log);

    // wire inactive controls immediately so elements exist
    const chk = document.getElementById('filterInactive');
    const slider = document.getElementById('inactiveDays');
    const val = document.getElementById('inactiveDaysVal');
    function updateVal(){ if(val && slider) val.textContent = `${slider.value}d`; }
    if(slider){ slider.addEventListener('input', ()=>{ updateVal(); try{ updateInactiveMarkers(); }catch(e){} }); updateVal(); }
    if(chk){ chk.addEventListener('change', ()=>{ try{ updateInactiveMarkers(); }catch(e){} }); }
  }catch(e){ console.debug('failed to add inactive controls', e); }
  const filterSeizedEl = document.getElementById('filterSeized');
  if(filterSeizedEl){
    filterSeizedEl.addEventListener('change', ()=>{
      window.__seizedOnly = filterSeizedEl.checked;
      const q = searchEl.value.trim().toLowerCase();
      // when toggling the seized-only filter, do not change the current map view/zoom
      // If seized-only is activated, automatically deactivate "All other vessels".
      try{
        const filterShipsEl = document.getElementById('filterShips');
        if(filterSeizedEl.checked){
          if(filterShipsEl){ filterShipsEl.checked = false; }
          setShipsVisible(false);
        }
      }catch(e){ console.debug('failed to auto-disable All other vessels', e); }
      filterShips(q, false);
    });
  }
  const filterCablesEl = document.getElementById('filterCables');
  if(filterCablesEl){
    filterCablesEl.addEventListener('change', async ()=>{
      if(filterCablesEl.checked){
        try{
          await ensureCablesLoaded();
          toggleCablesLayer(true);
        }catch(e){
          console.error('Failed to load cables.json', e);
          alert('Failed to load cables.json');
          filterCablesEl.checked = false;
        }
      } else {
        toggleCablesLayer(false);
      }
    });
  }
  const filterPipelinesEl = document.getElementById('filterPipelines');
  if(filterPipelinesEl){
    filterPipelinesEl.addEventListener('change', async ()=>{
      if(filterPipelinesEl.checked){
        try{
          await ensurePipelinesLoaded();
          togglePipelinesLayer(true);
        }catch(e){
          console.error('Failed to load pipelines.json', e);
          alert('Failed to load pipelines.json');
          filterPipelinesEl.checked = false;
        }
      } else {
        togglePipelinesLayer(false);
      }
    });
  }
}
  const filterShipsEl = document.getElementById('filterShips');
  if(filterShipsEl){
    filterShipsEl.checked = !!window.__shipsVisible;
    filterShipsEl.addEventListener('change', ()=>{
      const show = filterShipsEl.checked;
      setShipsVisible(show);
    });
  }

  const filterPortsEl = document.getElementById('filterPorts');
  if(filterPortsEl){
    filterPortsEl.checked = !!window.__portsVisible;
    filterPortsEl.addEventListener('change', ()=>{
      const show = filterPortsEl.checked;
      setPortsVisible(show);
    });
  }

  // wiring for inactive controls moved to ensureLegend to guarantee elements exist

// Cables layer handling (performance-optimized)
window.__cablesData = null;
window.__cablesLayerGroup = null;
window.__cablesVisible = false;
window.__CABLES_MIN_ZOOM = 6; // below this zoom cables will be hidden to save resources

async function ensureCablesLoaded(){
  if(window.__cablesData) return;
  const r = await fetch('cables.json');
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  window.__cablesData = j;

  // Use a Canvas renderer for much better performance with many segments
  const canvasRenderer = L.canvas({ padding: 0.5 });

  // Draw a faint halo first, then the main bright line on top (canvas renders both efficiently)
  const haloStyle = { color: 'rgba(0,255,102,0.12)', weight: 8, opacity: 1, interactive: false };
  // main layer remains canvas-rendered but is interactive so tooltips/hover work
  const mainStyle = { color: '#00ff66', weight: 2, opacity: 0.95, interactive: true };

  const haloLayer = L.geoJSON(window.__cablesData, { renderer: canvasRenderer, style: haloStyle, interactive: false });
  const mainLayer = L.geoJSON(window.__cablesData, {
    renderer: canvasRenderer,
    style: mainStyle,
    interactive: true,
    onEachFeature: function(feature, layer){
      try{
        const name = feature && feature.properties && (feature.properties.name || feature.properties.id || feature.properties.feature_id);
        if(name) layer.bindTooltip(String(name), {sticky:true, direction:'center', className:'cable-tooltip'});
      }catch(e){/* ignore */}
    }
  });

  window.__cablesLayerGroup = L.layerGroup([haloLayer, mainLayer]);

  // Zoom handler: hide cables when zoomed out to avoid rendering too many segments
  map.on('zoomend', function(){
    if(!window.__cablesVisible) return;
    try{
      if(map.getZoom() < window.__CABLES_MIN_ZOOM){
        if(map.hasLayer(window.__cablesLayerGroup)) map.removeLayer(window.__cablesLayerGroup);
      } else {
        if(!map.hasLayer(window.__cablesLayerGroup)) map.addLayer(window.__cablesLayerGroup);
      }
    }catch(e){/* ignore */}
  });
}

// Pipelines layer handling (performance-optimized, simplified coordinates)
window.__pipelinesData = null;
window.__pipelinesLayerGroup = null;
window.__pipelinesVisible = false;
window.__PIPELINES_MIN_ZOOM = window.__CABLES_MIN_ZOOM;

function thinCoordinates(coords, targetMax=1000){
  if(!Array.isArray(coords)) return coords;
  const n = coords.length;
  if(n <= targetMax) return coords;
  const step = Math.ceil(n / targetMax);
  const out = [];
  for(let i=0;i<n;i+=step) out.push(coords[i]);
  // ensure last point present
  if(out.length && (out[out.length-1][0] !== coords[n-1][0] || out[out.length-1][1] !== coords[n-1][1])) out.push(coords[n-1]);
  return out;
}

function simplifyGeoJSON(orig){
  if(!orig || !orig.type) return orig;
  const copy = JSON.parse(JSON.stringify(orig));
  if(copy.type === 'FeatureCollection' && Array.isArray(copy.features)){
    copy.features = copy.features.map(f=>{
      if(!f.geometry) return f;
      const g = f.geometry;
      if(g.type === 'LineString' && Array.isArray(g.coordinates)){
        g.coordinates = thinCoordinates(g.coordinates, 1200);
      } else if(g.type === 'MultiLineString' && Array.isArray(g.coordinates)){
        g.coordinates = g.coordinates.map(ls => thinCoordinates(ls, 1200));
      }
      return f;
    });
  }
  return copy;
}

async function ensurePipelinesLoaded(){
  if(window.__pipelinesData) return;
  const r = await fetch('pipelines.json');
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  // simplify on load to reduce rendering cost
  const simplified = simplifyGeoJSON(j);
  window.__pipelinesData = simplified;

  const canvasRenderer = L.canvas({ padding: 0.5 });
  const haloStyle = { color: 'rgba(0,255,255,0.10)', weight: 8, opacity: 1, interactive: false };
  const mainStyle = { color: '#00e6ff', weight: 2, opacity: 0.95, interactive: false };

  const haloLayer = L.geoJSON(window.__pipelinesData, { renderer: canvasRenderer, style: haloStyle, interactive: false });
  const mainLayer = L.geoJSON(window.__pipelinesData, { renderer: canvasRenderer, style: mainStyle, interactive: false });

  window.__pipelinesLayerGroup = L.layerGroup([haloLayer, mainLayer]);

  map.on('zoomend', function(){
    if(!window.__pipelinesVisible) return;
    try{
      if(map.getZoom() < window.__PIPELINES_MIN_ZOOM){
        if(map.hasLayer(window.__pipelinesLayerGroup)) map.removeLayer(window.__pipelinesLayerGroup);
      } else {
        if(!map.hasLayer(window.__pipelinesLayerGroup)) map.addLayer(window.__pipelinesLayerGroup);
      }
    }catch(e){/* ignore */}
  });
}

function togglePipelinesLayer(show){
  if(show){
    return ensurePipelinesLoaded().then(()=>{
      const cz = map.getZoom();
      if(cz < window.__PIPELINES_MIN_ZOOM){
        map.once('zoomend', function(){ try{ if(!map.hasLayer(window.__pipelinesLayerGroup)) map.addLayer(window.__pipelinesLayerGroup); }catch(e){} });
        try{ map.flyTo(map.getCenter(), window.__PIPELINES_MIN_ZOOM, {animate:true, duration:0.6}); }catch(e){ map.setView(map.getCenter(), window.__PIPELINES_MIN_ZOOM); }
      } else {
        try{ if(!map.hasLayer(window.__pipelinesLayerGroup)) map.addLayer(window.__pipelinesLayerGroup); }catch(e){}
      }
      window.__pipelinesVisible = true;
    });
  }
  if(window.__pipelinesLayerGroup && map.hasLayer(window.__pipelinesLayerGroup)){
    try{ map.removeLayer(window.__pipelinesLayerGroup); }catch(e){}
  }
  window.__pipelinesVisible = false;
}

function toggleCablesLayer(show){
  if(show){
    // ensure data loaded and then either zoom to min level (if currently too far) or add immediately
    return ensureCablesLoaded().then(()=>{
      const cz = map.getZoom();
      if(cz < window.__CABLES_MIN_ZOOM){
        // add the layer after zoom finishes to avoid rendering during animation
        map.once('zoomend', function(){
          try{ if(!map.hasLayer(window.__cablesLayerGroup)) map.addLayer(window.__cablesLayerGroup); }catch(e){}
        });
        try{
          map.flyTo(map.getCenter(), window.__CABLES_MIN_ZOOM, {animate:true, duration:0.6});
        }catch(e){
          map.setView(map.getCenter(), window.__CABLES_MIN_ZOOM);
        }
      } else {
        try{ if(!map.hasLayer(window.__cablesLayerGroup)) map.addLayer(window.__cablesLayerGroup); }catch(e){}
      }
      window.__cablesVisible = true;
    });
  }
  if(window.__cablesLayerGroup && map.hasLayer(window.__cablesLayerGroup)){
    try{ map.removeLayer(window.__cablesLayerGroup); }catch(e){}
  }
  window.__cablesVisible = false;
}

// create legend on load
ensureLegend();
// ensure our toggle wiring runs after legend injection
try{ wireVisibilityToggles(); }catch(e){ console.debug('wireVisibilityToggles after legend failed', e); }
// Ensure checkbox initial states for cables and seized filters
try{
  const filterCablesEl = document.getElementById('filterCables'); if(filterCablesEl) filterCablesEl.checked = !!window.__cablesVisible;
  const filterSeizedEl = document.getElementById('filterSeized'); if(filterSeizedEl) filterSeizedEl.checked = !!window.__seizedOnly;
}catch(e){ console.debug('initial legend state set failed', e); }

// Persist UI state (legend controls + map view) to localStorage
function saveUIState(){
  try{
    const state = {};
    const ids = ['filterShips','filterPorts','filterMilitary','filterLaw','filterSeized','filterCables','filterPipelines','toggleDarkMode','filterInactive'];
    ids.forEach(id=>{ const el = document.getElementById(id); if(!el) return; if(el.type === 'checkbox') state[id] = !!el.checked; else state[id] = el.value; });
    const slider = document.getElementById('inactiveDays'); if(slider) state.inactiveDays = Number(slider.value)||7;
    if(window && window.map && typeof map.getCenter === 'function'){
      const c = map.getCenter(); state.mapCenter = [c.lat, c.lng]; state.mapZoom = map.getZoom();
    }
    localStorage.setItem('shadowfleet_ui', JSON.stringify(state));
  }catch(e){ console.debug('saveUIState failed', e); }
}

function loadUIState(){
  try{
    const raw = localStorage.getItem('shadowfleet_ui'); if(!raw) return;
    const state = JSON.parse(raw);
    if(!state) return;
    // apply legend toggles
    try{ if(typeof state.filterShips === 'boolean'){ const el = document.getElementById('filterShips'); if(el) el.checked = state.filterShips; setShipsVisible(!!state.filterShips); } }catch(e){}
    try{ if(typeof state.filterPorts === 'boolean'){ const el = document.getElementById('filterPorts'); if(el) el.checked = state.filterPorts; setPortsVisible(!!state.filterPorts); } }catch(e){}
    try{ if(typeof state.filterMilitary === 'boolean'){ const el = document.getElementById('filterMilitary'); if(el) el.checked = state.filterMilitary; setMilitaryVisible(!!state.filterMilitary); } }catch(e){}
    try{ if(typeof state.filterLaw === 'boolean'){ const el = document.getElementById('filterLaw'); if(el) el.checked = state.filterLaw; setLawVisible(!!state.filterLaw); } }catch(e){}
    try{ if(typeof state.filterSeized === 'boolean'){ const el = document.getElementById('filterSeized'); if(el) el.checked = state.filterSeized; window.__seizedOnly = !!state.filterSeized; const q = (typeof searchEl !== 'undefined' && searchEl)? searchEl.value.trim().toLowerCase():''; filterShips(q, false); } }catch(e){}
    try{ if(typeof state.filterCables === 'boolean'){ const el = document.getElementById('filterCables'); if(el) el.checked = state.filterCables; if(state.filterCables) toggleCablesLayer(true); else toggleCablesLayer(false); } }catch(e){}
    try{ if(typeof state.filterPipelines === 'boolean'){ const el = document.getElementById('filterPipelines'); if(el) el.checked = state.filterPipelines; if(state.filterPipelines) togglePipelinesLayer(true); else togglePipelinesLayer(false); } }catch(e){}
    try{ if(typeof state.toggleDarkMode === 'boolean'){ const el = document.getElementById('toggleDarkMode'); if(el) el.checked = state.toggleDarkMode; setDarkMode(!!state.toggleDarkMode); } }catch(e){}
    try{ if(typeof state.filterInactive === 'boolean'){ const el = document.getElementById('filterInactive'); if(el) el.checked = state.filterInactive; } }catch(e){}
    try{ if(typeof state.inactiveDays !== 'undefined'){ const s = document.getElementById('inactiveDays'); const v = Number(state.inactiveDays)||7; if(s) s.value = v; const val = document.getElementById('inactiveDaysVal'); if(val) val.textContent = `${v}d`; } }catch(e){}
    // map view
    if(state.mapCenter && Array.isArray(state.mapCenter) && state.mapCenter.length===2 && typeof state.mapZoom === 'number'){
      try{ map.setView([Number(state.mapCenter[0]), Number(state.mapCenter[1])], Number(state.mapZoom)); }catch(e){}
    }
    // ensure inactive markers reflect loaded state
    try{ updateInactiveMarkers(); }catch(e){}
  }catch(e){ console.debug('loadUIState failed', e); }
}

// wire controls to persist on change
try{
  ['filterShips','filterPorts','filterMilitary','filterLaw','filterSeized','filterCables','filterPipelines','toggleDarkMode','filterInactive'].forEach(id=>{
    const el = document.getElementById(id); if(!el) return; el.addEventListener('change', ()=>{ try{ saveUIState(); }catch(e){} });
  });
  const sliderEl = document.getElementById('inactiveDays'); if(sliderEl) sliderEl.addEventListener('input', ()=>{ try{ saveUIState(); }catch(e){} });
  // persist map on move/zoom
  if(window && window.map){ map.on('moveend', ()=>{ try{ saveUIState(); }catch(e){} }); map.on('zoomend', ()=>{ try{ saveUIState(); }catch(e){} }); }
}catch(e){ console.debug('persist wiring failed', e); }

// load saved state now
try{ loadUIState(); }catch(e){ console.debug('initial loadUIState failed', e); }

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

fetch('ships.json').then(r=>r.json()).then(data=>{
  const list = Array.isArray(data)?data:data.result||data;
  allShips = list || [];

  // ensure notes and seized fields exist (defaults)
  allShips.forEach(it => {
    if(it.notes === undefined) it.notes = '';
    if(it.seized === undefined) it.seized = false;
  });

  // update total ships count in footer (if element present)
  try{
    const totalEl = document.getElementById('totalShips');
    if(totalEl) totalEl.textContent = String(allShips.length || 0);
  }catch(e){ console.debug('Could not update totalShips element', e); }

  // set last-updated from the newest timestamp across all entries
  if(allShips.length){
    let latestNum = null;
    let latestStr = null;
    allShips.forEach(it => {
      let ts = it.TIMESTAMP || it.timestamp || it.time || it.Time || it.updated_at || it.updatedAt;
      if(ts === undefined || ts === null) return;
      if(typeof ts === 'number'){
        if(latestNum === null || ts > latestNum) latestNum = ts;
        return;
      }
      const s = String(ts).trim();
      // numeric-looking string? treat as number
      const n = parseFloat(s);
      if(!Number.isNaN(n) && /^\d+(?:\.\d+)?$/.test(s)){
        if(latestNum === null || n > latestNum) latestNum = n;
      } else {
        if(latestStr === null || s > latestStr) latestStr = s;
      }
    });

    let display = '';
    if(latestNum !== null){
      // guess whether numeric is seconds or milliseconds
      if(latestNum > 1e12){
        try{ display = new Date(latestNum).toISOString(); }catch(e){ display = String(latestNum); }
      } else if(latestNum > 1e9){
        try{ display = new Date(latestNum * 1000).toISOString(); }catch(e){ display = String(latestNum); }
      } else {
        display = String(latestNum);
      }
    } else if(latestStr !== null){
      display = latestStr;
    }

    if(display){ lastUpdatedEl.textContent = `Last updated: ${display}`; }
  }

  allShips.forEach(item=>{
    // find latitude/longitude in multiple possible keys
    let _lat = item.LAT || item.latitude || item.lat || item.Latitude || item.Lat;
    let _lon = item.LON || item.longitude || item.lon || item.Longitude || item.Long || item.lng;
    const latf = parseFloat(_lat);
    const lonf = parseFloat(_lon);
    if(Number.isFinite(latf) && Number.isFinite(lonf)){
      // determine category for this vessel (military / law / civilian)
      function getShipCategory(it){
        const t = String(it.SHIPTYPE || it.TYPE_SUMMARY || it.TYPE || it.type || '').toLowerCase();
        if(!t) return 'civilian';
        if(t.indexOf('military') !== -1 || t.indexOf('navy') !== -1 || t.indexOf('warship') !== -1) return 'military';
        if(t.indexOf('law') !== -1 || t.indexOf('enforcement') !== -1 || t.indexOf('coast guard') !== -1 || t.indexOf('police') !== -1) return 'law';
        return 'civilian';
      }
      const category = getShipCategory(item);
      let colorOverride = null;
      if(category === 'military') colorOverride = '#0f766e';
      if(category === 'law') colorOverride = '#1e40af';
      // store bucket for future size-filter exemptions
      const winfo = getWeightInfo(item);
      const marker = L.marker([latf,lonf], {icon: makeLabelIcon(item, colorOverride)});
      marker.on('click', ()=> showDetails(item));
      // convenience properties for filtering
      try{ marker.__sf_category = category; marker.__sf_bucket = (winfo && winfo.bucket) ? winfo.bucket : 'small'; }catch(e){}
      markers.push({marker, item});
      // also add to category-specific layer groups for future use
      try{
        if(category === 'military') window.__militaryLayer.addLayer(marker);
        else if(category === 'law') window.__lawLayer.addLayer(marker);
      }catch(e){}
      markerGroup.addLayer(marker);
    }
  });
  // initial inactive marker update after markers created
  try{ updateInactiveMarkers(); }catch(e){}
  // keep the initial map center/zoom as configured above
  // (do not auto-fit bounds on load, which would override the default view)
}).catch(e=>{
  console.error('Failed to load ships.json', e);
  alert('Failed to load ships.json — run a local static server and ensure file exists.');
});

// Load ports and render with anchor icon
window.__portsLayer = L.layerGroup();
if(window.__portsVisible) window.__portsLayer.addTo(map);
function showPortDetails(feature){
  // normalize properties for both GeoJSON feature and flat-port objects
  const props = (feature && feature.properties && typeof feature.properties === 'object') ? feature.properties : (feature && typeof feature === 'object' ? feature : {});
  const coords = (feature && feature.geometry && feature.geometry.coordinates) ? feature.geometry.coordinates : (feature && (feature.coordinates || feature.coords) ? (feature.coordinates || feature.coords) : null);
  const lon = coords ? parseFloat(coords[0]) : null;
  const lat = coords ? parseFloat(coords[1]) : null;
  const name = props.name || props.port || props.title || props.id || 'Port';
  shipNameEl.textContent = name;
  // build metadata: include requested fields
  let meta = `<div><strong>Type:</strong> Port</div>`;
  if(props.city) meta += `<div><strong>City:</strong> ${escapeHtml(props.city)}</div>`;
  if(props.country) meta += `<div><strong>Country:</strong> ${escapeHtml(props.country)}</div>`;
  if(props.alias && props.alias.length) meta += `<div><strong>Alias:</strong> ${escapeHtml(String(props.alias))}</div>`;
  if(props.regions && props.regions.length) meta += `<div><strong>Regions:</strong> ${escapeHtml(String(props.regions))}</div>`;
  if(props.province) meta += `<div><strong>Province:</strong> ${escapeHtml(props.province)}</div>`;
  if(props.timezone) meta += `<div><strong>Timezone:</strong> ${escapeHtml(props.timezone)}</div>`;
  if(props.locs) meta += `<div><strong>Locs:</strong> ${escapeHtml(String(props.locs))}</div>`;
  if(Number.isFinite(lat) && Number.isFinite(lon)) meta += `<div><strong>Coordinates:</strong> ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
  shipMetaEl.innerHTML = meta;
  // show attack/notes area and clear image/links
  shipImageEl.innerHTML = '';
  linksEl.innerHTML = '';
  const shipNotesEl = document.getElementById('shipNotes');
  if(shipNotesEl){
    const details = props.attack_details || props.notes || '';
    if(String(details).trim()) shipNotesEl.innerHTML = `<div class="port-attack-details">${escapeHtml(String(details))}</div>`;
    else shipNotesEl.innerHTML = '<div class="notes-empty">—</div>';
  }
  // Remove any ship-specific controls (track button) when showing a port
  try{ removeTrackLayer(); }catch(e){}
  try{ const tbtn = document.getElementById('trackToggleBtn'); if(tbtn && tbtn.parentNode) tbtn.parentNode.removeChild(tbtn); }catch(e){}
  sidebar.classList.add('open');
}

fetch('ports.json').then(r=>r.json()).then(data=>{
  // Normalize supported formats: GeoJSON FeatureCollection, flat array, or object map
  let list = [];
  if(data && Array.isArray(data)){
    list = data.map(item=>{
      const coords = item.coordinates || item.coords || null;
      const props = Object.assign({}, item);
      if(coords){ delete props.coordinates; delete props.coords; }
      return {geometry:{coordinates: coords}, properties: props};
    }).filter(f=>f.geometry && f.geometry.coordinates && f.geometry.coordinates.length>=2);
  } else if(data && data.features && Array.isArray(data.features)){
    list = data.features;
  } else if(data && typeof data === 'object'){
    // object map: { key: { name, coordinates:[lon,lat], ... }, ... }
    list = Object.keys(data).map(k=>{
      const item = data[k] || {};
      const coords = item.coordinates || item.coords || null;
      const props = Object.assign({}, item);
      props._key = k;
      return {geometry:{coordinates: coords}, properties: props};
    }).filter(f=>f.geometry && f.geometry.coordinates && f.geometry.coordinates.length>=2);
  }
  window.__portsData = list;
  window.__portsMarkers = [];
  list.forEach(f=>{
    try{
      const coords = f.geometry && f.geometry.coordinates ? f.geometry.coordinates : null;
      if(!coords || coords.length < 2) return;
      const lon = parseFloat(coords[0]); const lat = parseFloat(coords[1]);
      if(!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const pname = (f.properties && (f.properties.name || f.properties.port || f.properties.title)) ? String(f.properties.name || f.properties.port || f.properties.title) : '';
      const iconHtml = `<img src="assets/anchor.svg" width="28" height="28" alt="${escapeHtml(pname)}" class="port-icon-img" />`;
      const portIcon = L.divIcon({html: iconHtml, className: 'port-marker', iconSize:[28,28], iconAnchor:[14,14]});
      const m = L.marker([lat,lon], {icon: portIcon, title: pname});
      m.on('click', ()=> showPortDetails(f.properties && Object.keys(f.properties).length ? f : f));
      try{ m.bindTooltip(pname, {permanent:false, direction:'top', opacity:0.95}); }catch(e){}
      window.__portsMarkers.push({marker:m, feature:f});
      if(window.__portsVisible) window.__portsLayer.addLayer(m);
    }catch(e){console.debug('port render failed', e);}    
  });
}).catch(e=>{ console.debug('Failed to load ports.json', e); });

// load country polygons for on-land detection (GeoJSON)
fetch('countries.geojson').then(r=>r.json()).then(data=>{
  try{
    window.__countriesGeo = data;
    window.__countryPolygons = [];
    if(data && Array.isArray(data.features)){
      for(const f of data.features){
        try{
          const geom = f.geometry; if(!geom) continue;
          if(geom.type === 'Polygon'){
            // polygon: array of rings
            window.__countryPolygons.push({rings: geom.coordinates, props: f.properties||{}});
          } else if(geom.type === 'MultiPolygon'){
            // multipolygon: array of polygons (each is array of rings)
            for(const poly of geom.coordinates) window.__countryPolygons.push({rings: poly, props: f.properties||{}});
          }
        }catch(e){}
      }
    }
    try{ console.warn('countries.geojson: loaded', Array.isArray(window.__countryPolygons) ? window.__countryPolygons.length : 0, 'polygons'); }catch(e){}
  }catch(e){ console.debug('Failed to process countries.geojson', e); }
}).catch(e=>{ console.debug('Failed to load countries.geojson', e); });

// global helper: point-in-polygon using ray-casting against preloaded country polygons
function isPointOnLand(lat, lon){
  try{
    const polys = Array.isArray(window.__countryPolygons) ? window.__countryPolygons : [];
    function pointInRing(x, y, ring){
      let inside = false;
      for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi>y) !== (yj>y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
        if(intersect) inside = !inside;
      }
      return inside;
    }
    for(const p of polys){
      try{
        const rings = p.rings || [];
        if(!rings || !rings.length) continue;
        // rings are arrays of [lon,lat]
        if(pointInRing(lon, lat, rings[0])){
          // not inside any hole
          let inHole = false;
          for(let h=1; h<rings.length; h++){
            if(pointInRing(lon, lat, rings[h])){ inHole = true; break; }
          }
          if(!inHole) return true;
        }
      }catch(e){}
    }
  }catch(e){}
  return false;
}

// include ports in search results
function filterPorts(q){
  if(!window.__portsMarkers) return;
  window.__portsLayer.clearLayers();
  const qnorm = (q||'').trim().toLowerCase();
  window.__portsMarkers.forEach(pm=>{
    const name = (pm.feature && pm.feature.properties && pm.feature.properties.name) ? String(pm.feature.properties.name).toLowerCase() : '';
    if(!qnorm){
      if(window.__portsVisible) window.__portsLayer.addLayer(pm.marker);
    } else {
      if(name.indexOf(qnorm) !== -1){ if(window.__portsVisible) window.__portsLayer.addLayer(pm.marker); }
    }
  });
}



function filterShips(q, fit = true){
  // q matches TYPE_SUMMARY, SHIPNAME, MMSI, IMO, FLAG, notes
  markerGroup.clearLayers();
  const seizedOnly = !!window.__seizedOnly;
  if(!q){
    markers.forEach(m=>{
      const cat = (m.marker && m.marker.__sf_category) ? m.marker.__sf_category : 'civilian';
      // determine whether category is currently selected/visible
      const categoryVisible = (cat === 'military' && !!window.__militaryVisible) || (cat === 'law' && !!window.__lawVisible) || (cat === 'civilian' && !!window.__shipsVisible);
      // when "only show selected categories" is enabled we rely on categoryVisible
      const categorySelected = !!window.__onlyShowCategories ? categoryVisible : categoryVisible;

      // size filter handling: military/law and seized vessels bypass the size filter
      const sizeFilterActive = !!window.__sizeFilterActive;
      const allowedBuckets = Array.isArray(window.__sizeFilterAllowedBuckets) ? window.__sizeFilterAllowedBuckets : null;
      if(sizeFilterActive && allowedBuckets){
        if(!(cat === 'military' || cat === 'law' || m.item.seized)){
          const mb = (m.marker && m.marker.__sf_bucket) ? m.marker.__sf_bucket : 'small';
          if(allowedBuckets.indexOf(mb) === -1) return;
        }
      }

      // final visibility: show if category is selected OR (seizedOnly and item is seized)
      if(!(categorySelected || (seizedOnly && m.item.seized))) return;

      markerGroup.addLayer(m.marker);
    });
    if(fit && markerGroup.getLayers().length) map.fitBounds(markerGroup.getBounds(),{padding:[60,60]});
    return;
  }
  markers.forEach(m=>{
    const it = m.item;
    const fields = [it.TYPE_SUMMARY, it.SHIPNAME, it.MMSI, it.IMO, it.FLAG, it.name, it.shipid, it.SHIP_ID, it.notes];
    const hay = fields.filter(Boolean).map(x=>String(x).toLowerCase()).join(' ');
    if(hay.indexOf(q) !== -1){
      const cat = (m.marker && m.marker.__sf_category) ? m.marker.__sf_category : 'civilian';
      // determine whether category is currently selected/visible
      const categoryVisible = (cat === 'military' && !!window.__militaryVisible) || (cat === 'law' && !!window.__lawVisible) || (cat === 'civilian' && !!window.__shipsVisible);
      const categorySelected = !!window.__onlyShowCategories ? categoryVisible : categoryVisible;
      const sizeFilterActive = !!window.__sizeFilterActive;
      const allowedBuckets = Array.isArray(window.__sizeFilterAllowedBuckets) ? window.__sizeFilterAllowedBuckets : null;
      if(sizeFilterActive && allowedBuckets){
        if(!(cat === 'military' || cat === 'law' || it.seized)){
          const mb = (m.marker && m.marker.__sf_bucket) ? m.marker.__sf_bucket : 'small';
          if(allowedBuckets.indexOf(mb) === -1) return;
        }
      }
      // final visibility: show if category is selected OR (seizedOnly and item is seized)
      if(!(categorySelected || (seizedOnly && it.seized))) return;
      markerGroup.addLayer(m.marker);
    }
  });
  if(fit && markerGroup.getLayers().length) map.fitBounds(markerGroup.getBounds(),{padding:[60,60]});
}

// (search input already wired above to filter ships+ports)


function openStatsModal(mode='both'){
  // build counts
  const byFlag = {};
  const byType = {};
  allShips.forEach(it=>{
    const flag = it.FLAG || it.flag || it.Country || 'Unknown';
    const type = it.SHIPTYPE || it.TYPE_SUMMARY || it.TYPE || it.type || 'Unknown';
    byFlag[flag] = (byFlag[flag]||0)+1;
    byType[type] = (byType[type]||0)+1;
  });

  // create overlay and modal
  const overlay = document.createElement('div'); overlay.className='overlay';
  const modal = document.createElement('div'); modal.className='stats-modal';
  const close = document.createElement('button'); close.className='close'; close.textContent='✕';
  close.addEventListener('click', ()=>{ document.body.removeChild(overlay); document.body.removeChild(modal); });
  modal.appendChild(close);
  // add title for the stats modal
  const titleEl = document.createElement('h2'); titleEl.className = 'stats-title';
  if(mode === 'flag') titleEl.textContent = 'Ships by Flag';
  else if(mode === 'type') titleEl.textContent = 'Ships by Type';
  else titleEl.textContent = 'Ships by Flag and Type';
  modal.appendChild(titleEl);
  const chartsWrap = document.createElement('div'); chartsWrap.className='charts';
  // create canvases depending on mode
  let c1 = null, c2 = null;
  if(mode === 'flag'){
    c1 = document.createElement('canvas'); c1.style.flex = '1 1 100%'; chartsWrap.appendChild(c1);
  }else if(mode === 'type'){
    c2 = document.createElement('canvas'); c2.style.flex = '1 1 100%'; chartsWrap.appendChild(c2);
  }else{
    c1 = document.createElement('canvas'); c2 = document.createElement('canvas'); chartsWrap.appendChild(c1); chartsWrap.appendChild(c2);
  }
  modal.appendChild(chartsWrap);
  document.body.appendChild(overlay); document.body.appendChild(modal);

  // prepare data for charts (take top 12 categories)
  function topN(obj,n=12){
    return Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n);
  }
  const topFlags = topN(byFlag,12);
  const topTypes = topN(byType,12);
  // ensure non-empty datasets
  const flagsLabels = topFlags.length ? topFlags.map(x=>x[0]) : ['No data'];
  const flagsData = topFlags.length ? topFlags.map(x=>x[1]) : [0];
  const typesLabels = topTypes.length ? topTypes.map(x=>x[0]) : ['No data'];
  const typesData = topTypes.length ? topTypes.map(x=>x[1]) : [0];
  if(mode === 'flag'){
    new Chart(c1.getContext('2d'),{
      type:'bar',
      data:{labels:flagsLabels,datasets:[{label:'Ships per FLAG',data:flagsData,backgroundColor:'#06b6d4'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }else if(mode === 'type'){
    new Chart(c2.getContext('2d'),{
      type:'bar',
      data:{labels:typesLabels,datasets:[{label:'Ships per TYPE',data:typesData,backgroundColor:'#60a5fa'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }else{
    new Chart(c1.getContext('2d'),{
      type:'bar',
      data:{labels:flagsLabels,datasets:[{label:'Ships per FLAG',data:flagsData,backgroundColor:'#06b6d4'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
    new Chart(c2.getContext('2d'),{
      type:'bar',
      data:{labels:typesLabels,datasets:[{label:'Ships per TYPE',data:typesData,backgroundColor:'#60a5fa'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }
}
