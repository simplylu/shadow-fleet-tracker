/* Global app script for ShadowFleet map */
const map = L.map('map', {zoomControl: true}).setView([55, 13], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

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

searchEl.addEventListener('input', ()=>{
  const q = searchEl.value.trim().toLowerCase();
  filterShips(q);
});

statsBtn.addEventListener('click', ()=>{
  openStatsModal('flag');
});

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
  for(const k of ['IMO','MMSI','LAT','LON','SPEED','HEADING','COURSE','SHIPTYPE','LENGTH','WIDTH','FLAG','TIMESTAMP']){
    if(data[k]!==undefined && data[k]!==null){
      let value = data[k];
      // ships.json already contains mapped SHIPTYPE strings; show as-is, fallback to UNKNOWN
      if(k === 'SHIPTYPE' && (value === undefined || value === null || value === '')){
        value = 'UNKNOWN';
      }
      lines.push(`<div><strong>${k}:</strong> ${escapeHtml(value)}</div>`);
    }
  }
  shipMetaEl.innerHTML = lines.join('');

  // links
  const shipid = data.SHIP_ID || data.shipid || '';
  const imo = data.IMO || data.imo || '';
  linksEl.innerHTML = '';
  const a1 = document.createElement('a'); a1.href = `https://www.marinetraffic.com/en/ais/home/shipid:${shipid}/zoom:14`; a1.textContent='Marinetraffic'; a1.target='_blank';
  const a2 = document.createElement('a'); a2.href = `https://www.vesselfinder.com/vessels/details/${imo}`; a2.textContent='Vesselfinder'; a2.target='_blank';
  const a3 = document.createElement('a'); a3.href = `https://war-sanctions.gur.gov.ua/en/transport/shadow-fleet?f%5Bsearch%5D=${encodeURIComponent(imo)}&f%5Bc%5D=&f%5Bt%5D=&f%5Bn%5D=&f%5Bgroup_id%5D=&f-ca=&f-cs=&f%5Bcs2%5D=&f%5Bma%5D=`; a3.textContent='War Sanctions'; a3.target='_blank';
  const li1 = document.createElement('li'); li1.appendChild(a1);
  const li2 = document.createElement('li'); li2.appendChild(a2);
  const li3 = document.createElement('li'); li3.appendChild(a3);
  linksEl.appendChild(li1); linksEl.appendChild(li2); linksEl.appendChild(li3);

  // add Ecosia websearch for the vessel name (lowercased) if available
  const vesselName = (data.SHIPNAME || data.name || '').toString().trim();
  if(vesselName){
    const nameLower = vesselName.toLowerCase();
    const q = `"shadow fleet" "russia" "${nameLower}"`;
    const ecosiaUrl = `https://www.ecosia.org/search?method=index&q=${encodeURIComponent(q)}`;
    const a4 = document.createElement('a'); a4.href = ecosiaUrl; a4.textContent = 'Ecosia Websearch'; a4.target = '_blank'; a4.rel = 'noopener noreferrer';
    const li4 = document.createElement('li'); li4.appendChild(a4);
    linksEl.appendChild(li4);
  }

  // add Opensanctions search link if IMO available
  if(imo){
    const opensanctionsUrl = `https://www.opensanctions.org/search/?q=${encodeURIComponent('IMO'+imo)}`;
    const a5 = document.createElement('a'); a5.href = opensanctionsUrl; a5.textContent = 'Opensanctions'; a5.target = '_blank'; a5.rel = 'noopener noreferrer';
    const li5 = document.createElement('li'); li5.appendChild(a5);
    linksEl.appendChild(li5);
  }

  sidebar.classList.add('open');
}


async function fetchVesselfinderImage(imo){
  // First try a local proxy (see proxy.py) to avoid CORS issues.
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

function makeLabelIcon(item){
  // item may contain heading and label fields
  const label = item.SHIPNAME || item.name || item.SHIP_ID || item.shipid || '';
  let heading = null;
  for(const k of ['HEADING','heading','Heading']){
    if(item[k]!==undefined && item[k]!==null){
      const v = parseFloat(item[k]);
      if(Number.isFinite(v)) { heading = v; break; }
    }
  }
  // decide color and size based on weight-like fields
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
    // default small
    const buckets = {small:{color:'#16a34a',size:20,label:'Small'}, medium:{color:'#f59e0b',size:28,label:'Medium'}, large:{color:'#ef4444',size:36,label:'Large'}};
    if(!keyFound) return {key:null,value:null, bucket:'small', color:buckets.small.color, size:buckets.small.size, label:buckets.small.label};
    const k = keyFound.toUpperCase();
    // decide thresholds based on key
    if(['DWT','DWT','DWT_MT'].includes(k)){
      if(val < 5000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:`<5000 DWT`};
      if(val < 20000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:`5k-20k DWT`};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:`>20k DWT`};
    }
    if(['GT','GRT','GT','GRT'].includes(k)){
      if(val < 1000) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label:`<1k GT`};
      if(val < 10000) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:buckets.medium.size,label:`1k-10k GT`};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:buckets.large.size,label:`>10k GT`};
    }
    if(k === 'LENGTH'){
      if(val < 80) return {key:k,value:val,bucket:'small',color:buckets.small.color,size:18,label:`<80 m`};
      if(val < 180) return {key:k,value:val,bucket:'medium',color:buckets.medium.color,size:26,label:`80-180 m`};
      return {key:k,value:val,bucket:'large',color:buckets.large.color,size:34,label:`>180 m`};
    }
    // fallback: small
    return {key:k,value:val,bucket:'small',color:buckets.small.color,size:buckets.small.size,label: String(val)};
  }

  const winfo = getWeightInfo(item);

  // create SVG and apply rotation if heading present
  const rotateStyle = heading!==null ? `transform: rotate(${heading}deg); transform-origin: ${winfo.size/2}px ${winfo.size/2}px;` : '';
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

  const html = `<div class="ship-marker-wrap">${svg}${labelHtml}</div>`;
  return L.divIcon({
    className: 'ship-marker',
    html: html,
    iconSize: [140,36],
    iconAnchor: [16,18],
    popupAnchor: [0,-10]
  });
}

// Inject a legend explaining weight buckets
function ensureLegend(){
  if(document.getElementById('map-legend')) return;
  const legend = document.createElement('div'); legend.id = 'map-legend'; legend.className = 'map-legend';
  legend.innerHTML = `
    <div class="legend-title">Size / Weight (length criteria)</div>
    <div class="legend-row"><span class="swatch" style="background:#16a34a"></span><span class="lbl">Small — &lt; 80 m</span></div>
    <div class="legend-row"><span class="swatch" style="background:#f59e0b"></span><span class="lbl">Medium — 80–180 m</span></div>
    <div class="legend-row"><span class="swatch" style="background:#ef4444"></span><span class="lbl">Large — &gt; 180 m</span></div>
  `;
  document.body.appendChild(legend);
}

// create legend on load
ensureLegend();

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

fetch('ships.json').then(r=>r.json()).then(data=>{
  const list = Array.isArray(data)?data:data.result||data;
  allShips = list || [];

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
      const marker = L.marker([latf,lonf], {icon: makeLabelIcon(item)});
      marker.on('click', ()=> showDetails(item));
      markers.push({marker, item});
      markerGroup.addLayer(marker);
    }
  });
  // keep the initial map center/zoom as configured above
  // (do not auto-fit bounds on load, which would override the default view)
}).catch(e=>{
  console.error('Failed to load ships.json', e);
  alert('Failed to load ships.json — run a local static server and ensure file exists.');
});



function filterShips(q){
  // q matches TYPE_SUMMARY, SHIPNAME, MMSI, IMO, FLAG
  markerGroup.clearLayers();
  if(!q){
    markers.forEach(m=> markerGroup.addLayer(m.marker));
    if(markerGroup.getLayers().length) map.fitBounds(markerGroup.getBounds(),{padding:[60,60]});
    return;
  }
  markers.forEach(m=>{
    const it = m.item;
    const fields = [it.TYPE_SUMMARY, it.SHIPNAME, it.MMSI, it.IMO, it.FLAG, it.name, it.shipid, it.SHIP_ID];
    const hay = fields.filter(Boolean).map(x=>String(x).toLowerCase()).join(' ');
    if(hay.indexOf(q) !== -1){
      markerGroup.addLayer(m.marker);
    }
  });
  if(markerGroup.getLayers().length) map.fitBounds(markerGroup.getBounds(),{padding:[60,60]});
}


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
