'use strict';

const SERVICES = {
  shower:      { icon: '🚿', label: 'Душ' },
  toilet:      { icon: '🚽', label: 'Туалет' },
  security:    { icon: '🔒', label: 'Охрана' },
  restaurant:  { icon: '☕', label: 'Ресторан' },
  electricity: { icon: '⚡', label: 'Электричество' },
};

const TILE_LAYERS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    },
    overlay: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      options: { attribution: '', maxZoom: 19, opacity: 0.8 },
    },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      attribution: '© <a href="https://www.esri.com/">Esri</a>',
      maxZoom: 19,
    },
    overlay: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      options: {
        attribution: '',
        maxZoom: 19,
        opacity: 1,
      },
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
    this.activeType         = null;
    this.filterPaid         = null;
    this.routeLayer         = null;
    this.routeActive        = false;
    this.currentLayer       = 'dark';
    this.tileLayer          = null;
    this.overlayLayer       = null;
    this._userLocationLabel = '📍 Моё местоположение';
  }

  // ─── ENTRY POINT ────────────────────────────────────────────
  async init() {
    this.initTelegram();
    this.initMap();
    this.initUI();
    await this.loadParkings();
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

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

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
  async loadParkings() {
    try {
      const res  = await fetch('./data/parkings.kml');
      const text = await res.text();
      const dom  = new DOMParser().parseFromString(text, 'text/xml');
      const geo  = toGeoJSON.kml(dom);

      this.allParkings = geo.features
        .filter(f => f.geometry?.type === 'Point')
        .map((f, idx) => {
          const p        = f.properties || {};
          const services = p.services
            ? p.services.split(',').map(s => s.trim()).filter(Boolean)
            : [];
          return {
            id:      idx,
            name:    p.name    || 'Парковка',
            address: p.address || '',
            spots:   p.spots   ? parseInt(p.spots, 10) : null,
            type:    p.type    || '',
            services,
            paid:    p.paid === 'true',
            rating:  p.rating  ? parseFloat(p.rating)  : null,
            lat:     f.geometry.coordinates[1],
            lon:     f.geometry.coordinates[0],
          };
        });

      this.renderMarkers(this.allParkings);
    } catch (err) {
      console.error('KML load error:', err);
    }
  }

  // ─── MARKERS ────────────────────────────────────────────────
  makeIcon(highlight = false) {
    return L.divIcon({
      className: '',
      html: `<div class="parking-marker${highlight ? ' route-highlight' : ''}">P</div>`,
      iconSize:   [34, 34],
      iconAnchor: [17, 17],
    });
  }

  renderMarkers(parkings, highlightIds = new Set()) {
    this.clusterGroup.clearLayers();
    this.markerMap.clear();

    parkings.forEach(parking => {
      const icon   = this.makeIcon(highlightIds.has(parking.id));
      const marker = L.marker([parking.lat, parking.lon], { icon });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.showPanel(parking);
      });

      this.clusterGroup.addLayer(marker);
      this.markerMap.set(parking.id, marker);
    });
  }

  // ─── BOTTOM SHEET ───────────────────────────────────────────
  showPanel(parking) {
    // Name
    document.getElementById('parking-name').textContent = parking.name;

    // Distance badge
    const distEl = document.getElementById('parking-distance');
    if (this.userPosition) {
      const km = this.haversine(
        this.userPosition.lat, this.userPosition.lon,
        parking.lat, parking.lon,
      );
      distEl.textContent = km < 1
        ? `${Math.round(km * 1000)} м`
        : `${km.toFixed(1)} км`;
      distEl.classList.remove('hidden');
    } else {
      distEl.classList.add('hidden');
    }

    // Coordinates row
    const coordsRow = document.getElementById('parking-coords-row');
    const coordsText = `${parking.lat.toFixed(6)}, ${parking.lon.toFixed(6)}`;
    document.getElementById('parking-coords').textContent = coordsText;
    coordsRow.classList.remove('hidden');
    document.getElementById('parking-coords-copy').onclick = () => {
      navigator.clipboard.writeText(coordsText).then(() => {
        const btn = document.getElementById('parking-coords-copy');
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      }).catch(() => {
        // Fallback for environments without clipboard API
        const ta = document.createElement('textarea');
        ta.value = coordsText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        const btn = document.getElementById('parking-coords-copy');
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      });
    };

    // Rating
    const ratingEl = document.getElementById('parking-rating');
    if (parking.rating) {
      ratingEl.textContent = `⭐ ${parking.rating}`;
      ratingEl.style.display = '';
    } else {
      ratingEl.style.display = 'none';
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

    // Animate in
    const sheet = document.getElementById('bottom-sheet');
    sheet.classList.remove('hidden');
    requestAnimationFrame(() => sheet.classList.add('visible'));
  }

  hidePanel() {
    const sheet = document.getElementById('bottom-sheet');
    sheet.classList.remove('visible');
    setTimeout(() => sheet.classList.add('hidden'), 340);
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
          this._userLocationLabel = '📍 Моё местоположение';
          fromInput.value = this._userLocationLabel;
        }
      },
      (err) => console.warn('Geolocation denied:', err),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // ─── FILTERS ────────────────────────────────────────────────
  applyFilters() {
    const hasFilter = this.activeFilters.size > 0 || this.activeType || this.filterPaid !== null;
    if (!hasFilter) {
      this.renderMarkers(this.allParkings);
      return;
    }
    const filtered = this.allParkings.filter(p => {
      if (this.activeType && p.type !== this.activeType) return false;
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
    let from, to;

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
  }

  clearRoute() {
    if (this.routeLayer) {
      this.map.removeLayer(this.routeLayer);
      this.routeLayer = null;
    }
    this.routeActive = false;
    this.renderMarkers(this.allParkings);
    document.getElementById('route-clear-btn').classList.add('hidden');
    document.getElementById('route-from').value =
      this.userPosition ? (this._userLocationLabel || '📍 Моё местоположение') : '';
    document.getElementById('route-to').value = '';
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

    // Add road labels overlay for satellite (hybrid mode)
    if (cfg.overlay) {
      this.overlayLayer = L.tileLayer(cfg.overlay.url, cfg.overlay.options).addTo(this.map);
    }

    const btn = document.getElementById('layer-btn');
    btn.textContent = this.currentLayer === 'dark' ? '🛰️' : '🗺';
    btn.title       = this.currentLayer === 'dark' ? 'Спутник' : 'Карта';
  }

  // ─── UI WIRING ──────────────────────────────────────────────
  initUI() {
    this._initFilters();
    this._initDims();
    this._initRoute();
    this._initLocate();
    this._initLayerToggle();
    this._initAddParking();
  }

  // ─── TOAST NOTIFICATION ─────────────────────────────────────
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
          e.target !== btn) {
        panel.classList.add('hidden');
        btn.classList.remove('active');
      }
    });

    // Service chips (amenities + security) — multi-select
    document.querySelectorAll('.chip:not(.type-chip)').forEach(chip => {
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

    // Type chips — single select (toggle off if clicked again)
    document.querySelectorAll('.type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.type;
        if (this.activeType === t) {
          this.activeType = null;
          chip.classList.remove('active');
        } else {
          this.activeType = t;
          document.querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
        }
        this.applyFilters();
      });
    });

    // Payment toggle
    document.getElementById('filter-paid-toggle').addEventListener('change', (e) => {
      this.filterPaid = e.target.checked ? true : null;
      this.applyFilters();
    });

    // Reset all
    document.getElementById('filter-clear').addEventListener('click', () => {
      this.activeFilters.clear();
      this.activeType  = null;
      this.filterPaid  = null;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      document.getElementById('filter-paid-toggle').checked = false;
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
  }

  _initLocate() {
    document.getElementById('locate-btn').addEventListener('click', () => {
      if (this.userPosition) {
        this.map.setView([this.userPosition.lat, this.userPosition.lon], 14);
      } else {
        this.getUserLocation();
      }
    });
  }

  _initLayerToggle() {
    document.getElementById('layer-btn').addEventListener('click', () => {
      this.toggleLayer();
    });
  }

  // ─── ADD PARKING FORM ───────────────────────────────────────
  openAddModal() {
    const center = this.map.getCenter();
    document.getElementById('add-coords').value = `${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}`;
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
    document.getElementById('add-paid').checked = false;
    document.querySelectorAll('.service-check').forEach(el => {
      el.classList.remove('checked');
      el.querySelector('input').checked = false;
    });
  }

  _initAddParking() {
    document.getElementById('add-parking-btn').addEventListener('click', () => {
      this.openAddModal();
    });

    // Service chip toggle
    document.querySelectorAll('.service-check').forEach(label => {
      label.addEventListener('click', () => {
        const cb = label.querySelector('input');
        cb.checked = !cb.checked;
        label.classList.toggle('checked', cb.checked);
      });
    });

    // Use my location
    document.getElementById('add-use-location-btn').addEventListener('click', () => {
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

    const services = Array.from(document.querySelectorAll('.service-check input:checked'))
      .map(cb => cb.value)
      .join(',');

    const data = {
      type:     'new_parking',
      name,
      lat,
      lon,
      services,
      paid:     document.getElementById('add-paid').checked,
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
