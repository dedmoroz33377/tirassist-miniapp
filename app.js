'use strict';

// Public API base URL (set this to your server's HTTPS address)
const API_BASE_URL = 'https://tirassist-api.example.com';  // TODO: replace with actual URL

const ADMIN_TG_ID = 642423348;

const SERVICES = {
  shower:     { icon: '<img src="icon_shower.png" width="14" style="vertical-align:middle">', label: 'Душ' },
  toilet:     { icon: '<img src="icon_wc.png" width="14" style="vertical-align:middle">', label: 'Туалет' },
  restaurant: { icon: '<img src="icon_cafe.png" width="14" style="vertical-align:middle">', label: 'Кафе' },
  laundry:    { icon: '<img src="icon_laundry.png" width="14" style="vertical-align:middle">', label: 'Прачечная' },
  lighting:   { icon: '💡', label: 'Освещение' },
  fencing:    { icon: '🚧', label: 'Ограждение' },
  dkv:        { icon: '<img src="dkv.png" width="16" style="vertical-align:middle">', label: 'DKV' },
  snap:       { icon: '<img src="snap.png" width="16" style="vertical-align:middle">', label: 'Snap' },
};

const TILE_LAYERS = {
  dark: {
    url: 'https://mt{s}.google.com/vt/lyrs=y&hl=ru&x={x}&y={y}&z={z}',
    options: {
      attribution: '© Google',
      subdomains: '0123',
      maxZoom: 20,
    },
  },
  satellite: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    },
    overlay: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      options: { attribution: '', maxZoom: 19, opacity: 0.7 },
    },
  },
};

class TirAssistApp {
  constructor() {
    this.map                = null;
    this.clusterGroup       = null;
    this.allParkings        = [];
    this.markerMap          = new Map();   // parking.id → L.marker
    this.userPosition       = null;
    this.userMarker         = null;
    this.activeFilters      = new Set();
    this.activeTypes        = new Set();   // multi-select for parking types
    this.filterPaid         = null;
    this.routeLayer         = null;
    this.routeActive        = false;
    this.currentLayer       = 'dark';
    this.tileLayer          = null;
    this.overlayLayer       = null;
    this._userLocationLabel = 'Моё местоположение.';
  }

  // ─── ENTRY POINT ────────────────────────────────────────────
  async init() {
    this.initTelegram();
    this.initMap();
    this.initUI();
    // From-dot starts empty until geolocation resolves
    document.querySelector('.route-dot-from')?.classList.add('empty');

    // Splash: minimum 2.2s, then hide with fade
    const splashStart = Date.now();
    await this.loadParkings();
    const elapsed = Date.now() - splashStart;
    const remaining = Math.max(0, 1300 - elapsed);
    setTimeout(() => {
      document.getElementById('splash-screen')?.classList.add('hide');
    }, remaining);

    this.getUserLocation();
  }

  // ─── TELEGRAM MINI APP ──────────────────────────────────────
  initTelegram() {
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
  }

  // ─── MAP SETUP ──────────────────────────────────────────────
  initMap() {
    this.map = L.map('map', {
      center: [51.5, 18.0],
      zoom: 6,
      zoomControl: false,
    });

    const def = TILE_LAYERS.dark;
    this.tileLayer = L.tileLayer(def.url, def.options).addTo(this.map);

    this.clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        return L.divIcon({
          className: 'cluster-icon',
          html: `<div class="parking-marker">${n}</div>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        });
      },
    });

    this.map.addLayer(this.clusterGroup);
    this.map.on('click', () => this.hidePanel());
  }

  // ─── LOAD & PARSE KML ───────────────────────────────────────
  _getNodeText(node, tagName) {
    if (!node) return '';
    // Try with and without namespace (handles both namespaced and plain XML)
    let el = node.getElementsByTagName(tagName)[0]
           || node.getElementsByTagNameNS('*', tagName)[0]
           || node.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', tagName)[0];
    return el ? (el.textContent || '').trim() : '';
  }

  _parseExtendedData(placemark) {
    const result = {};
    // Use both methods to handle namespace differences
    const dataTags = [
      ...Array.from(placemark.getElementsByTagName('Data')),
      ...Array.from(placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Data')),
    ];
    // Deduplicate by unique node reference
    const seen = new Set();
    for (const data of dataTags) {
      if (seen.has(data)) continue;
      seen.add(data);
      const name = data.getAttribute('name');
      if (!name) continue;
      const val = this._getNodeText(data, 'value');
      result[name] = val;
    }
    return result;
  }

  async _parsePlacemarksFromKml(url) {
    try {
      const res  = await fetch(url);
      const text = await res.text();
      const dom  = new DOMParser().parseFromString(text, 'text/xml');

      const seen = new Set();
      const placemarks = [
        ...Array.from(dom.getElementsByTagName('Placemark')),
        ...Array.from(dom.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Placemark')),
      ].filter(n => { if (seen.has(n)) return false; seen.add(n); return true; });

      const result = [];
      for (const pm of placemarks) {
        const coordText = this._getNodeText(pm, 'coordinates');
        if (!coordText) continue;
        const parts = coordText.split(',');
        if (parts.length < 2) continue;
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (isNaN(lat) || isNaN(lon)) continue;

        const name = this._getNodeText(pm, 'name') || 'Парковка';
        const p    = this._parseExtendedData(pm);
        const services = p.services
          ? p.services.split(',').map(s => s.trim()).filter(Boolean)
          : [];

        result.push({
          name,
          address:     p.address     || '',
          description: (p.description || '').trim(),
          spots:       p.spots ? parseInt(p.spots, 10) : null,
          type:        p.type        || 'parking',
          services,
          paid:        p.paid === 'true',
          rating:      p.rating ? parseFloat(p.rating) : null,
          source:      p.source      || 'db',
          db_id:       p.db_id ? parseInt(p.db_id, 10) : null,
          lat,
          lon,
        });
      }
      return result;
    } catch (err) {
      console.warn(`KML load warning (${url}):`, err);
      return [];
    }
  }

  async loadParkings() {
    try {
      const [dbPoints, userPoints] = await Promise.all([
        this._parsePlacemarksFromKml('./data/parkings.kml?v=2'),
        this._parsePlacemarksFromKml('./data/user_parkings.kml?v=2'),
      ]);

      const allPoints = [...dbPoints, ...userPoints];
      this.allParkings = allPoints.map((p, idx) => ({ id: idx, ...p }));

      console.log(`KML: BD TIR=${dbPoints.length}, community=${userPoints.length}, paid=${this.allParkings.filter(p=>p.paid).length}`);

      this.renderMarkers(this.allParkings);
    } catch (err) {
      console.error('KML load error:', err);
    }
  }

  // ─── MARKERS ────────────────────────────────────────────────
  _iconUrl(parking) {
    const type     = (parking.type || 'parking').toLowerCase();
    const services = parking.services || [];
    if (type === 'магазин')           return 'shop.png';
    if (type === 'prom')              return 'prom.png';
    if (type === 'spot')              return 'spot.png?v=2';
    if (services.includes('snap'))    return 'snap.png';
    if (services.includes('dkv'))     return 'dkv.png';
    if (services.includes('laundry')) return 'laundry.png';
    if (parking.paid)                 return 'parking_cash.png';
    return 'parking_free.png';
  }

  makeIcon(parking, active = false) {
    const url = this._iconUrl(parking);
    return L.divIcon({
      className: '',
      html: `<div class="map-marker-wrap${active ? ' map-marker-active' : ''}">
               <img src="${url}" width="38" height="38">
             </div>`,
      iconSize:   [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -22],
    });
  }

  _setActiveMarker(parkingId) {
    // Reset previous
    if (this._activeMarkerId != null) {
      const prev = this.markerMap.get(this._activeMarkerId);
      if (prev) {
        const parking = this.allParkings.find(p => p.id === this._activeMarkerId);
        if (parking) prev.setIcon(this.makeIcon(parking, false));
      }
    }
    // Highlight new
    this._activeMarkerId = parkingId;
    const marker = this.markerMap.get(parkingId);
    if (marker) {
      const parking = this.allParkings.find(p => p.id === parkingId);
      if (parking) marker.setIcon(this.makeIcon(parking, true));
    }
  }

  renderMarkers(parkings, highlightIds = new Set()) {
    this.clusterGroup.clearLayers();
    this.markerMap.clear();
    this._activeMarkerId = null;

    parkings.forEach(parking => {
      const icon   = this.makeIcon(parking, highlightIds.has(parking.id));
      const marker = L.marker([parking.lat, parking.lon], { icon });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this._setActiveMarker(parking.id);
        this.showPanel(parking);
      });

      this.clusterGroup.addLayer(marker);
      this.markerMap.set(parking.id, marker);
    });
  }

  // ─── BOTTOM SHEET ───────────────────────────────────────────
  showPanel(parking) {
    this._currentParking = parking;

    // Name
    document.getElementById('parking-name').textContent = parking.name;

    // Admin delete button (only for user-submitted parkings with db_id)
    const deleteBtn = document.getElementById('parking-delete-btn');
    const isAdmin = window.Telegram?.WebApp?.initDataUnsafe?.user?.id === ADMIN_TG_ID;
    if (isAdmin && parking.db_id) {
      deleteBtn.classList.remove('hidden');
      deleteBtn.onclick = () => this._adminDeleteParking(parking);
    } else {
      deleteBtn.classList.add('hidden');
    }

    // Distance badge
    const distEl = document.getElementById('parking-distance');
    if (this.userPosition) {
      const straightKm = this.haversine(
        this.userPosition.lat, this.userPosition.lon,
        parking.lat, parking.lon,
      );
      const fmtKm = km => km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`;
      distEl.classList.add('hidden');
      this._fetchRoadDistance(this.userPosition, { lat: parking.lat, lon: parking.lon })
        .then(roadKm => {
          if (roadKm != null) {
            distEl.textContent = fmtKm(roadKm);
            distEl.classList.remove('hidden');
          }
        })
        .catch(() => {});
    } else {
      distEl.classList.add('hidden');
    }

    // Coordinates row
    const coordsRow = document.getElementById('parking-coords-row');
    const coordsText = `${parking.lat.toFixed(6)}, ${parking.lon.toFixed(6)}`;
    document.getElementById('parking-coords').textContent = coordsText;
    coordsRow.classList.remove('hidden');
    const copyBtn = document.getElementById('parking-coords-copy');
    const copySvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
    const checkSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" style="color:#22C55E"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    copyBtn.onclick = () => {
      const doCopy = () => {
        copyBtn.innerHTML = checkSvg;
        copyBtn.style.borderColor = 'rgba(34,197,94,0.4)';
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.style.borderColor = '';
        }, 1500);
      };
      navigator.clipboard.writeText(coordsText).then(doCopy).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = coordsText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        doCopy();
      });
    };

    // Description
    const descRow = document.getElementById('parking-description-row');
    const descWrap = document.getElementById('parking-description-wrap');
    const descEl = document.getElementById('parking-description');
    const descToggle = document.getElementById('parking-description-toggle');
    const DESC_COLLAPSE_LEN = 150;
    if (parking.description) {
      descEl.textContent = parking.description;
      descRow.classList.remove('hidden');
      descWrap.classList.remove('description-expanded');
      if (parking.description.length > DESC_COLLAPSE_LEN) {
        descEl.classList.add('description-truncated');
        descToggle.classList.remove('hidden');
        descToggle.textContent = 'Развернуть';
        descToggle.onclick = () => {
          const expanded = descWrap.classList.toggle('description-expanded');
          descEl.classList.toggle('description-truncated', !expanded);
          descToggle.textContent = expanded ? 'Свернуть' : 'Развернуть';
        };
      } else {
        descEl.classList.remove('description-truncated');
        descToggle.classList.add('hidden');
      }
    } else {
      descEl.textContent = '';
      descRow.classList.add('hidden');
    }

    // Services
    const tags = [];
    tags.push(parking.paid
      ? `<div class="service-tag paid">💰 Платно</div>`
      : `<div class="service-tag free">🆓 Бесплатно</div>`
    );
    parking.services.forEach(s => {
      const cfg = SERVICES[s];
      if (cfg) tags.push(`<div class="service-tag">${cfg.icon} ${cfg.label}</div>`);
    });
    document.getElementById('services-row').innerHTML = tags.join('');

    // Google Maps button
    document.getElementById('maps-btn').onclick = () => {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${parking.lat},${parking.lon}&travelmode=driving`;
      window.open(url, '_blank');
    };

    // Load reviews
    this._loadReviews(parking);

    // Animate in
    const sheet = document.getElementById('bottom-sheet');
    sheet.classList.remove('hidden');
    requestAnimationFrame(() => sheet.classList.add('visible'));
  }

  _parkingKey(parking) {
    return `${parking.lat.toFixed(6)},${parking.lon.toFixed(6)}`;
  }

  async _loadReviews(parking) {
    const key = this._parkingKey(parking);
    const summaryEl = document.getElementById('parking-rating-summary');
    const starsEl = document.getElementById('parking-rating-stars');
    const countEl = document.getElementById('parking-rating-count');
    const listEl = document.getElementById('reviews-list');

    listEl.innerHTML = '<div style="color:#6b6b8a;font-size:13px;padding:6px 0">Загрузка отзывов…</div>';
    summaryEl.classList.add('hidden');

    try {
      const resp = await fetch(`${API_BASE_URL}/v1/reviews?parking_key=${encodeURIComponent(key)}`);
      if (!resp.ok) throw new Error('api');
      const data = await resp.json();

      // Summary
      if (data.count > 0) {
        starsEl.textContent = this._starsText(data.avg_rating);
        countEl.textContent = `${data.avg_rating} · ${data.count} отзыв${this._reviewWord(data.count)}`;
        summaryEl.classList.remove('hidden');
      } else {
        summaryEl.classList.add('hidden');
      }

      // List
      const isAdmin = window.Telegram?.WebApp?.initDataUnsafe?.user?.id === ADMIN_TG_ID;
      if (data.items.length === 0) {
        listEl.innerHTML = '<div style="color:#6b6b8a;font-size:13px;padding:4px 0 8px">Отзывов пока нет. Будьте первым!</div>';
      } else {
        listEl.innerHTML = data.items.map(r => `
          <div class="review-item" data-review-id="${r.id}">
            <div class="review-item-header">
              <span class="review-item-stars">${this._starsText(r.rating)}</span>
              <div style="display:flex;align-items:center;gap:6px">
                <span class="review-item-meta">${r.user_name || 'Аноним'} · ${this._formatDate(r.created_at)}</span>
                ${isAdmin ? `<button class="review-item-delete" title="Удалить отзыв" onclick="app._adminDeleteReview(${r.id})">
                  <img src="icon_delete.png" width="16" alt="del">
                </button>` : ''}
              </div>
            </div>
            ${r.comment ? `<div class="review-item-text">${this._escHtml(r.comment)}</div>` : ''}
          </div>`).join('');
      }
    } catch {
      listEl.innerHTML = '';
      summaryEl.classList.add('hidden');
    }
  }

  _starsText(rating) {
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }
  _reviewWord(n) {
    if (n % 10 === 1 && n % 100 !== 11) return '';
    if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'а';
    return 'ов';
  }
  _formatDate(iso) {
    const d = new Date(iso);
    return `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}.${d.getFullYear()}`;
  }
  _escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async _adminDeleteParking(parking) {
    if (!confirm(`Удалить парковку «${parking.name}»?`)) return;
    const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    try {
      const resp = await fetch(`${API_BASE_URL}/v1/parkings/${parking.db_id}?admin_tg_user_id=${tgId}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('api');
      this.hidePanel();
      this._showToast('Метка удалена. Карта обновится через ~1 мин.');
      // Remove marker from map
      const marker = this.markerMap.get(parking.id);
      if (marker) { this.clusterGroup.removeLayer(marker); this.markerMap.delete(parking.id); }
    } catch {
      this._showToast('Ошибка при удалении', 'error');
    }
  }

  async _adminDeleteReview(reviewId) {
    if (!confirm('Удалить этот отзыв?')) return;
    const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    try {
      const resp = await fetch(`${API_BASE_URL}/v1/reviews/${reviewId}?admin_tg_user_id=${tgId}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('api');
      // Reload reviews
      if (this._currentParking) this._loadReviews(this._currentParking);
    } catch {
      this._showToast('Ошибка при удалении отзыва', 'error');
    }
  }

  _initReviews() {
    let selectedStar = 0;
    const stars = document.querySelectorAll('.star-input');
    stars.forEach(s => {
      s.addEventListener('click', () => {
        selectedStar = parseInt(s.dataset.star);
        stars.forEach(st => st.classList.toggle('selected', parseInt(st.dataset.star) <= selectedStar));
      });
      s.addEventListener('mouseenter', () => {
        const hov = parseInt(s.dataset.star);
        stars.forEach(st => st.classList.toggle('selected', parseInt(st.dataset.star) <= hov));
      });
    });
    document.getElementById('review-stars-input').addEventListener('mouseleave', () => {
      stars.forEach(st => st.classList.toggle('selected', parseInt(st.dataset.star) <= selectedStar));
    });

    document.getElementById('review-submit-btn').addEventListener('click', async () => {
      if (!selectedStar) { this._showToast('Выберите оценку'); return; }
      const parking = this._currentParking;
      if (!parking) return;
      const comment = document.getElementById('review-comment').value.trim();
      const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
      const btn = document.getElementById('review-submit-btn');
      btn.disabled = true;
      try {
        const resp = await fetch(`${API_BASE_URL}/v1/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parking_key: this._parkingKey(parking),
            user_tg_id: tgUser?.id || 0,
            user_name: tgUser ? (tgUser.first_name || tgUser.username) : 'Аноним',
            rating: selectedStar,
            comment: comment || null,
            parking_id: parking.db_id || null,
          }),
        });
        if (!resp.ok) throw new Error('api');
        selectedStar = 0;
        stars.forEach(st => st.classList.remove('selected'));
        document.getElementById('review-comment').value = '';
        this._loadReviews(parking);
        this._showToast('Отзыв отправлен!');
      } catch {
        this._showToast('Ошибка отправки отзыва', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  hidePanel() {
    const sheet = document.getElementById('bottom-sheet');
    sheet.classList.remove('visible');
    setTimeout(() => sheet.classList.add('hidden'), 340);
    // Reset active marker highlight
    if (this._activeMarkerId != null) {
      const marker  = this.markerMap.get(this._activeMarkerId);
      const parking = this.allParkings?.find(p => p.id === this._activeMarkerId);
      if (marker && parking) marker.setIcon(this.makeIcon(parking, false));
      this._activeMarkerId = null;
    }
  }

  // ─── GEOLOCATION ────────────────────────────────────────────
  getUserLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        this.userPosition = { lat: coords.latitude, lon: coords.longitude };

        if (this.userMarker) this.map.removeLayer(this.userMarker);
        this.userMarker = L.marker(
          [this.userPosition.lat, this.userPosition.lon],
          {
            icon: L.divIcon({
              className: '',
              html: '<div class="user-marker"></div>',
              iconSize:   [16, 16],
              iconAnchor: [8, 8],
            }),
            zIndexOffset: 1000,
          },
        ).addTo(this.map);

        this.map.setView([this.userPosition.lat, this.userPosition.lon], 10);

        // Auto-fill "From" field with sentinel (only if user hasn't typed anything)
        const fromInput = document.getElementById('route-from');
        if (!fromInput.value || fromInput.value === this._userLocationLabel) {
          this._userLocationLabel = 'Моё местоположение.';
          fromInput.value = this._userLocationLabel;
          this._syncFromClear();
        }
      },
      (err) => console.warn('Geolocation denied:', err),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // ─── FILTERS ────────────────────────────────────────────────
  applyFilters() {
    const hasFilter = this.activeFilters.size > 0 || this.activeTypes.size > 0 || this.filterPaid !== null;
    if (!hasFilter) {
      this.renderMarkers(this.allParkings);
      return;
    }
    const filtered = this.allParkings.filter(p => {
      if (this.activeTypes.size > 0 && !this.activeTypes.has(p.type)) return false;
      if (this.filterPaid !== null && p.paid !== this.filterPaid) return false;
      for (const f of this.activeFilters) {
        if (!p.services.includes(f)) return false;
      }
      return true;
    });
    this.renderMarkers(filtered);
  }

  // ─── SEARCH (Nominatim) ─────────────────────────────────────
  async geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=ru`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'TirAssist/1.0' } });
    return res.json();
  }

  // ─── ROUTE MODE ─────────────────────────────────────────────
  async buildRoute(fromQ, toQ) {
    document.getElementById('route-loading').classList.remove('hidden');
    let from, to;
    try {

    // Resolve "from"
    if (fromQ === this._userLocationLabel && this.userPosition) {
      from = { lat: this.userPosition.lat, lon: this.userPosition.lon };
    } else {
      try {
        const fromR = await this.geocode(fromQ);
        if (!fromR.length) { alert('Адрес отправления не найден.'); return; }
        from = { lat: +fromR[0].lat, lon: +fromR[0].lon };
      } catch {
        alert('Ошибка геокодирования. Проверьте интернет-соединение.');
        return;
      }
    }

    // Resolve "to"
    try {
      const toR = await this.geocode(toQ);
      if (!toR.length) { alert('Адрес назначения не найден. Уточните запрос.'); return; }
      to = { lat: +toR[0].lat, lon: +toR[0].lon };
    } catch {
      alert('Ошибка геокодирования. Проверьте интернет-соединение.');
      return;
    }

    // Get route from ORS (HGV profile with vehicle restrictions)
    const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk0NWUxNTJmNDMwMTQyM2VhMjJiMmI4ZWY2OThlNDNkIiwiaCI6Im11cm11cjY0In0=';
    const dims = this.getVehicleDims();
    let routePoints = [[from.lat, from.lon], [to.lat, to.lon]];
    let routedByORS = false;
    try {
      const orsBody = {
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
        options: {
          vehicle_type: 'hgv',
          profile_params: {
            restrictions: {
              height: dims.height,
              width:  dims.width,
              length: dims.length,
              weight: dims.weight,
            },
          },
        },
      };
      const ors = await fetch(
        'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson',
        {
          method: 'POST',
          headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(orsBody),
        }
      );
      const orsData = await ors.json();
      if (orsData.features?.[0]?.geometry?.coordinates) {
        routePoints = orsData.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
        routedByORS = true;
      }
    } catch {
      console.warn('ORS unavailable, falling back to OSRM');
    }

    // Fallback: OSRM (no vehicle restrictions)
    if (!routedByORS) {
      this.showToast('⚠️ Маршрут без учёта габаритов — сервис ограничений временно недоступен');
      try {
        const osrm = await fetch(
          `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`,
        );
        const data = await osrm.json();
        if (data.routes?.[0]?.geometry?.coordinates) {
          routePoints = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        }
      } catch {
        console.warn('OSRM unavailable, using straight line');
      }
    }

    // Draw polyline
    if (this.routeLayer) this.map.removeLayer(this.routeLayer);
    this.routeLayer = L.polyline(routePoints, {
      color:   '#4fc3f7',
      weight:  5,
      opacity: 0.85,
    }).addTo(this.map);
    this.map.fitBounds(this.routeLayer.getBounds(), { padding: [60, 60] });

    // Find parkings within 5 km corridor
    const CORRIDOR_KM = 5;
    const nearRoute = this.allParkings.filter(p => {
      for (let i = 0; i < routePoints.length - 1; i++) {
        const d = this.pointSegmentDist(
          p.lat, p.lon,
          routePoints[i][0],   routePoints[i][1],
          routePoints[i+1][0], routePoints[i+1][1],
        );
        if (d <= CORRIDOR_KM) return true;
      }
      return false;
    });

    const highlightIds = new Set(nearRoute.map(p => p.id));
    this.renderMarkers(nearRoute, highlightIds);
    this.routeActive = true;
    document.getElementById('route-clear-btn').classList.remove('hidden');

    } finally {
      document.getElementById('route-loading').classList.add('hidden');
    }
  }

  clearRoute() {
    if (this.routeLayer) {
      this.map.removeLayer(this.routeLayer);
      this.routeLayer = null;
    }
    this.routeActive = false;
    this.renderMarkers(this.allParkings);
    document.getElementById('route-clear-btn').classList.add('hidden');
    const fromEl = document.getElementById('route-from');
    fromEl.value = this.userPosition ? (this._userLocationLabel || 'Моё местоположение.') : '';
    document.getElementById('route-to').value = '';
    this._syncFromClear();
    this._syncToClear();
  }

  // ─── ROAD DISTANCE via OSRM ─────────────────────────────────
  async _fetchRoadDistance(from, to) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/` +
        `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes?.length) return null;
      return data.routes[0].distance / 1000; // metres → km
    } catch {
      return null;
    }
  }

  // ─── MATH ───────────────────────────────────────────────────
  haversine(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Minimum distance from point P to segment AB (km)
  pointSegmentDist(pLat, pLon, aLat, aLon, bLat, bLon) {
    const dx = bLon - aLon;
    const dy = bLat - aLat;
    if (dx === 0 && dy === 0) return this.haversine(pLat, pLon, aLat, aLon);
    const t  = Math.max(0, Math.min(1,
      ((pLon - aLon) * dx + (pLat - aLat) * dy) / (dx * dx + dy * dy),
    ));
    return this.haversine(pLat, pLon, aLat + t * dy, aLon + t * dx);
  }

  // ─── LAYER TOGGLE ───────────────────────────────────────────
  toggleLayer() {
    this.currentLayer = this.currentLayer === 'dark' ? 'satellite' : 'dark';
    const cfg = TILE_LAYERS[this.currentLayer];

    // Remove existing layers
    this.map.removeLayer(this.tileLayer);
    if (this.overlayLayer) {
      this.map.removeLayer(this.overlayLayer);
      this.overlayLayer = null;
    }

    // Add base tile layer
    this.tileLayer = L.tileLayer(cfg.url, cfg.options).addTo(this.map);
    this.tileLayer.bringToBack();

    // Add road labels overlay if defined
    if (cfg.overlay) {
      this.overlayLayer = L.tileLayer(cfg.overlay.url, cfg.overlay.options).addTo(this.map);
    }

    const btn = document.getElementById('layer-btn');
    // dark = currently showing hybrid satellite → icon shows "map" (switch to scheme)
    // satellite = currently showing dark → icon shows "satellite_alt" (switch to hybrid)
    const isSatellite = this.currentLayer === 'dark'; // dark is the Google Hybrid
    document.getElementById('layer-icon-satellite')?.classList.toggle('hidden', !isSatellite);
    document.getElementById('layer-icon-map')?.classList.toggle('hidden', isSatellite);
    btn.title = isSatellite ? 'Переключить на схему' : 'Переключить на спутник';
    btn.classList.toggle('active', !isSatellite);
  }

  // ─── UI WIRING ──────────────────────────────────────────────
  initUI() {
    this._initFilters();
    this._initDims();
    this._initRoute();
    this._initLocate();
    this._initZoom();
    this._initLayerToggle();
    this._initAddParking();
    this._initReviews();
  }

  // ─── TOAST NOTIFICATION ─────────────────────────────────────
  _showToast(message, type = 'info', duration = 3000) {
    this.showToast(message, duration);
  }

  showToast(message, duration = 4000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, duration);
  }

  // ─── VEHICLE DIMENSIONS ─────────────────────────────────────
  _defaultDims() {
    return { height: 4, width: 2.5, length: 16.5, weight: 40 };
  }

  getVehicleDims() {
    const raw = localStorage.getItem('vehicleDims');
    return raw ? JSON.parse(raw) : this._defaultDims();
  }

  _initDims() {
    const defaults = this.getVehicleDims();
    document.getElementById('dim-height').value = defaults.height;
    document.getElementById('dim-width').value  = defaults.width;
    document.getElementById('dim-length').value = defaults.length;
    document.getElementById('dim-weight').value = defaults.weight;

    // Tab switching
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        document.getElementById('pane-filters').classList.toggle('hidden', target !== 'filters');
        document.getElementById('pane-dims').classList.toggle('hidden', target !== 'dims');
      });
    });

    // Save dims
    document.getElementById('dims-save').addEventListener('click', () => {
      const dims = {
        height: parseFloat(document.getElementById('dim-height').value) || this._defaultDims().height,
        width:  parseFloat(document.getElementById('dim-width').value)  || this._defaultDims().width,
        length: parseFloat(document.getElementById('dim-length').value) || this._defaultDims().length,
        weight: parseFloat(document.getElementById('dim-weight').value) || this._defaultDims().weight,
      };
      localStorage.setItem('vehicleDims', JSON.stringify(dims));
      const btn = document.getElementById('dims-save');
      btn.textContent = 'Сохранено ✅';
      setTimeout(() => { btn.textContent = 'Сохранить'; }, 1500);
    });
  }

  _initFilters() {
    const btn   = document.getElementById('filter-btn');
    const panel = document.getElementById('filter-panel');

    btn.addEventListener('click', () => {
      const open = !panel.classList.contains('hidden');
      panel.classList.toggle('hidden', open);
      btn.classList.toggle('active', !open);
      // Close route panel (legacy elements may not exist)
      document.getElementById('route-panel')?.classList.add('hidden');
      document.getElementById('route-btn')?.classList.remove('active');
    });

    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') &&
          !panel.contains(e.target) &&
          !btn.contains(e.target)) {
        panel.classList.add('hidden');
        btn.classList.remove('active');
      }
    });

    // Service fchips (amenities + security) — multi-select
    document.querySelectorAll('.fchip:not(.type-chip):not(.pay-btn)').forEach(chip => {
      chip.addEventListener('click', () => {
        const f = chip.dataset.filter;
        if (this.activeFilters.has(f)) {
          this.activeFilters.delete(f);
          chip.classList.remove('active');
        } else {
          this.activeFilters.add(f);
          chip.classList.add('active');
        }
        this.applyFilters();
      });
    });

    // Type fchips — multi-select
    document.querySelectorAll('.fchip.type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.type;
        if (this.activeTypes.has(t)) {
          this.activeTypes.delete(t);
          chip.classList.remove('active');
        } else {
          this.activeTypes.add(t);
          chip.classList.add('active');
        }
        this.applyFilters();
      });
    });

    // Payment fchips (Бесплатно / Платно)
    document.querySelectorAll('.fchip.pay-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.paid === 'true';
        if (this.filterPaid === val) {
          this.filterPaid = null;
          btn.classList.remove('active');
        } else {
          this.filterPaid = val;
          document.querySelectorAll('.fchip.pay-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
        this.applyFilters();
      });
    });

    // Reset all
    document.getElementById('filter-clear').addEventListener('click', () => {
      this.activeFilters.clear();
      this.activeTypes.clear();
      this.filterPaid  = null;
      document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
      this.renderMarkers(this.allParkings);
    });
  }

  _initRoute() {
    document.getElementById('route-go-btn').addEventListener('click', async () => {
      const from = document.getElementById('route-from').value.trim();
      const to   = document.getElementById('route-to').value.trim();
      if (!from || !to) {
        alert('Введите пункт назначения.');
        return;
      }
      // Close filter panel if open
      document.getElementById('filter-panel').classList.add('hidden');
      document.getElementById('filter-btn').classList.remove('active');
      await this.buildRoute(from, to);
    });

    document.getElementById('route-to').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('route-go-btn').click();
    });

    document.getElementById('route-clear-btn').addEventListener('click', () => {
      this.clearRoute();
    });

    // Show ✕ when typing in "From" field; clear on ✕ click
    const fromEl  = document.getElementById('route-from');
    const clearEl = document.getElementById('route-from-clear');
    fromEl?.addEventListener('input', () => this._syncFromClear());
    clearEl?.addEventListener('click', () => {
      fromEl.value = '';
      this._syncFromClear();
      fromEl.focus();
    });

    // Show ✕ when typing in "To" field; clear on ✕ click
    const toEl      = document.getElementById('route-to');
    const toClearEl = document.getElementById('route-to-clear');
    toEl?.addEventListener('input', () => this._syncToClear());
    toClearEl?.addEventListener('click', () => {
      toEl.value = '';
      this._syncToClear();
      toEl.focus();
    });
  }

  _initLocate() {
    // Main locate button — flies to user position
    document.getElementById('locate-btn').addEventListener('click', () => {
      if (this.userPosition) {
        this.map.setView([this.userPosition.lat, this.userPosition.lon], 14);
      } else {
        this.getUserLocation();
      }
    });

    // locate-in-route-btn — fills "From" field with current position
    document.getElementById('locate-in-route-btn')?.addEventListener('click', () => {
      if (this.userPosition) {
        this._userLocationLabel = 'Моё местоположение.';
        const fromEl = document.getElementById('route-from');
        fromEl.value = this._userLocationLabel;
        this._syncFromClear();
      } else {
        this.getUserLocation();
      }
    });
  }

  // Show/hide the ✕ clear button for the "From" field
  _syncFromClear() {
    const fromEl = document.getElementById('route-from');
    const clearBtn = document.getElementById('route-from-clear');
    if (!clearBtn) return;
    clearBtn.classList.toggle('hidden', !fromEl.value);
  }

  // Show/hide the ✕ clear button for the "To" field
  _syncToClear() {
    const toEl = document.getElementById('route-to');
    const clearBtn = document.getElementById('route-to-clear');
    if (!clearBtn) return;
    clearBtn.classList.toggle('hidden', !toEl.value);
  }

  _initZoom() {
    document.getElementById('zoom-in-btn').addEventListener('click', () => this.map.zoomIn());
    document.getElementById('zoom-out-btn').addEventListener('click', () => this.map.zoomOut());
  }

  _initLayerToggle() {
    // Set initial icon state: starts on 'dark' (Google Hybrid) → show satellite_alt icon
    document.getElementById('layer-icon-satellite')?.classList.remove('hidden');
    document.getElementById('layer-icon-map')?.classList.add('hidden');
    document.getElementById('layer-btn').title = 'Переключить на схему';
    document.getElementById('layer-btn').addEventListener('click', () => {
      this.toggleLayer();
    });
  }

  // ─── ADD PARKING FORM ───────────────────────────────────────
  openAddModal() {
    document.getElementById('add-modal').classList.remove('hidden');
  }

  closeAddModal() {
    document.getElementById('add-modal').classList.add('hidden');
    this._resetAddForm();
  }

  _fillCoords(lat, lon) {
    document.getElementById('add-coords').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }

  _resetAddForm() {
    document.getElementById('add-name').value = '';
    document.getElementById('add-coords').value = '';
    document.querySelectorAll('.service-check, .amenity-chip').forEach(el => {
      el.classList.remove('checked');
      el.querySelector('input').checked = false;
    });
    // Reset type to default (parking)
    document.querySelectorAll('.type-chip-add').forEach(c => c.classList.remove('active'));
    const first = document.querySelector('.type-chip-add[data-type="parking"]');
    if (first) first.classList.add('active');
    // Reset payment to default (free)
    document.querySelectorAll('.pay-btn-add').forEach(b => b.classList.remove('active'));
    const freBtn = document.querySelector('.pay-btn-add[data-paid="false"]');
    if (freBtn) freBtn.classList.add('active');
  }

  _initAddParking() {
    document.getElementById('add-parking-btn').addEventListener('click', () => {
      this.openAddModal();
    });

    // Type chip single-select
    document.querySelectorAll('.type-chip-add').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-chip-add').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Payment button single-select
    document.querySelectorAll('.pay-btn-add').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pay-btn-add').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Service/amenity chip toggle (supports both .service-check and .amenity-chip)
    document.querySelectorAll('.service-check, .amenity-chip').forEach(label => {
      label.addEventListener('click', () => {
        const cb = label.querySelector('input');
        cb.checked = !cb.checked;
        label.classList.toggle('checked', cb.checked);
      });
    });

    // Paste from clipboard
    document.getElementById('add-coords-paste')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) document.getElementById('add-coords').value = text.trim();
      } catch {
        this.showToast('Нет доступа к буферу обмена');
      }
    });

    // Insert my location
    document.getElementById('add-coords-locate')?.addEventListener('click', () => {
      if (this.userPosition) {
        this._fillCoords(this.userPosition.lat, this.userPosition.lon);
      } else {
        alert('Геолокация недоступна. Разрешите доступ к местоположению.');
      }
    });

    // Submit
    document.getElementById('add-submit-btn').addEventListener('click', () => {
      this._submitParking();
    });
  }

  _submitParking() {
    const name = document.getElementById('add-name').value.trim();
    if (!name) {
      alert('Введите название парковки.');
      return;
    }

    const coordsRaw = document.getElementById('add-coords').value.trim();
    const parts = coordsRaw.split(/[\s,;]+/);
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      alert('Введите координаты в формате:\n52.2156, 20.7834');
      return;
    }

    const services = Array.from(document.querySelectorAll('.service-check input:checked, .amenity-chip input:checked'))
      .map(cb => cb.value)
      .join(',');

    const activeTypeChip = document.querySelector('.type-chip-add.active');
    const parkingType = activeTypeChip ? activeTypeChip.dataset.type : 'parking';

    const activePaidBtn = document.querySelector('.pay-btn-add.active');
    const isPaid = activePaidBtn ? activePaidBtn.dataset.paid === 'true' : false;

    const data = {
      type:         'new_parking',
      parking_type: parkingType,
      name,
      lat,
      lon,
      services,
      paid:         isPaid,
    };

    if (window.Telegram?.WebApp?.sendData) {
      window.Telegram.WebApp.sendData(JSON.stringify(data));
    } else {
      // Dev fallback — show data in alert
      alert('sendData (dev):\n' + JSON.stringify(data, null, 2));
      this.closeAddModal();
    }
  }
}

// Bootstrap
const app = new TirAssistApp();
app.init();
