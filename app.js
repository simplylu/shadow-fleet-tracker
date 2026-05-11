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

  // create SVG and apply rotation if heading present
  const rotateStyle = heading!==null ? `transform: rotate(${heading}deg); transform-origin: 12px 12px;` : '';
  const svg = `
    <svg width="28" height="28" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="${rotateStyle}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <polygon points="2,12 20,4 20,20" fill="#e11d1d" filter="url(#shadow)" />
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

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

fetch('ships.json').then(r=>r.json()).then(data=>{
  const list = Array.isArray(data)?data:data.result||data;
  allShips = list || [];

  // set last-updated from first entry if present
  if(allShips.length){
    const first = allShips[0];
    const ts = first.TIMESTAMP || first.timestamp || first.time || first.TIMESTAMP || first.Time;
    if(ts){ lastUpdatedEl.textContent = `Last updated: ${ts}`; }
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
