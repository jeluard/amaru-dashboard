import { describeSource, readRuntimeConfig } from "./config.js";
import { createStateStore } from "./domain.js";
import { triggerEpochCelebration } from "./epoch-celebration.js";
import { initEraHistory } from "./era-history-wasm.js";
import { geolocatePeer } from "./geo.js";
import { createGlobe } from "./globe.js";
import { connectToStream } from "./socket.js";
import { clamp, formatRelativeAge, sparklinePath, truncateMiddle } from "./utils.js";
import { CountUp } from "countup.js";

function setConnectionState(snapshot) {
  const pill = document.querySelector("#connection-pill");
  const sourceLabel = document.querySelector("#source-label");

  const classes = {
    connecting: "status-pill status-pill--idle",
    live: "status-pill status-pill--live",
    closed: "status-pill status-pill--idle",
    error: "status-pill status-pill--error",
    idle: "status-pill status-pill--idle"
  };

  pill.textContent = snapshot.connectionState.kind;
  pill.className = classes[snapshot.connectionState.kind] || classes.idle;
  sourceLabel.textContent = snapshot.connectionState.label;
}

function renderStreamBanner(snapshot) {
  const banner = document.querySelector("#stream-banner");
  const title = document.querySelector("#stream-banner-title");
  const copy = document.querySelector("#stream-banner-copy");

  if (snapshot.hasData || snapshot.connectionState.kind === "live") {
    banner.hidden = true;
    return;
  }

  const states = {
    idle: {
      title: "Waiting for live telemetry",
      copy: "Looking for a local websocket stream."
    },
    connecting: {
      title: "Connecting to live stream",
      copy: snapshot.connectionState.label.startsWith("trying ")
        ? `${snapshot.connectionState.label}.`
        : `Trying ${snapshot.connectionState.label}.`
    },
    live: {
      title: "Connected, waiting for first events",
      copy: `The websocket is open on ${snapshot.connectionState.label}, but no spans or metrics have arrived yet.`
    },
    closed: {
      title: "Live stream closed",
      copy: `${snapshot.connectionState.label}.`
    },
    error: {
      title: "No live data",
      copy: `${snapshot.connectionState.label}. Start the backend or pass a websocket explicitly with #ws=ws://host:port/ws.`
    }
  };

  const message = states[snapshot.connectionState.kind] || states.idle;
  title.textContent = message.title;
  copy.textContent = message.copy;
  banner.hidden = false;
}

function renderHero(snapshot) {
  const block = snapshot.currentBlock;
  const epoch = snapshot.currentEpoch;

  document.querySelector("#current-block-number").textContent = block?.number ?? "--";
  document.querySelector("#current-block-hash").textContent = block ? truncateMiddle(block.hash, 12, 10) : "No block yet";
  document.querySelector("#current-slot").textContent = block?.slot ?? snapshot.tipSlot ?? "--";
  document.querySelector("#epoch-number").textContent = epoch?.epoch ?? "--";

  const percentage = Math.round((epoch?.progress || 0) * 100);
  document.querySelector("#epoch-percent").textContent = `${percentage}%`;
  document.querySelector("#epoch-detail").textContent = epoch
    ? `${epoch.slotInEpoch.toLocaleString()} of ${epoch.epochSizeSlots.toLocaleString()} slots`
    : "Waiting for slot data";
  document.querySelector("#epoch-progress-bar").style.width = `${clamp(percentage, 0, 100)}%`;
}

const _countUpInstances = new Map(); // key → { compact: CountUp }
const _lastKnownValue = new Map(); // key → last non-zero value for all metrics

const RATE_METRICS = new Set([
  "process_disk_live_read", "process_disk_live_write",
  "process_cpu_live",
]);

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function isDurationMetric(metric) {
  return metric.unit === "s" || metric.unit === "seconds";
}

function isBytesMetric(metric) {
  return metric.unit === "By" || metric.unit === "bytes" || metric.unit === "byte";
}

function isPercentMetric(metric) {
  return metric.unit === "%" || metric.unit === "1" || metric.name === "process_cpu_live";
}

function formatBytes(bytes) {
  const b = Math.round(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function formatMetricValue(metric) {
  if (isDurationMetric(metric)) return formatDuration(metric.value);
  if (isBytesMetric(metric)) return formatBytes(metric.value);
  if (Math.abs(metric.value) >= 10_000) return formatCount(metric.value);
  return null; // let CountUp handle small plain numbers
}

// ── Metrics selection / persistence ──────────────────────────────────────────

const METRICS_STORAGE_KEY = "amaru-ui:metrics-selection";
const DEFAULT_METRICS = new Set([
  "process_cpu_live",
  "process_memory",
  "process_disk_live_read",
  "process_disk_live_write",
  "apply_block",
  "rollbacks",
]);

/** All metric names ever seen this session, for populating the picker. */
const _allKnownMetrics = new Map(); // name → shortLabel

function getMetricsSelection() {
  try {
    const raw = localStorage.getItem(METRICS_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return null; // null → use DEFAULT_METRICS
}

function saveMetricsSelection(nameSet) {
  localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify([...nameSet]));
}

const METRIC_SHORT_LABELS = {
  // process / runtime (OpenTelemetry)
  process_runtime:                 "Uptime",
  process_disk_total_read:         "Disk read",
  process_disk_total_write:        "Disk write",
  process_disk_live_read:          "Live reads",
  process_disk_live_write:         "Live writes",
  process_cpu_live:                "CPU %",
  process_memory:                  "Memory",
  process_memory_rss:              "RSS mem",
  // ledger context
  add_fees:                        "Tx fees",
  require_bootstrap_witness:       "Boot witness",
  require_script_witness:          "Script wit",
  require_vkey_witness:            "VKey wit",
  vote:                            "Gov vote",
  withdraw_from:                   "Withdrawal",
  // certificates
  certificate_committee_delegate:  "Cold deleg",
  certificate_committee_resign:    "Cmttee exit",
  certificate_drep_registration:   "DRep reg",
  certificate_drep_retirement:     "DRep exit",
  certificate_drep_update:         "DRep update",
  certificate_pool_registration:   "Pool reg",
  certificate_pool_retirement:     "Pool exit",
  certificate_stake_delegation:    "Stake deleg",
  certificate_stake_deregistration:"Stake dereg",
  certificate_stake_registration:  "Stake reg",
  certificate_vote_delegation:     "Vote deleg",
  // ledger pipeline
  ratify_proposals:                "Ratify",
  apply_block:                     "Block apply",
  begin_epoch:                     "Epoch start",
  compute_rewards:                 "Rewards",
  compute_stake_distribution:      "Stake distrib",
  create_validation_context:       "Valid ctx",
  end_epoch:                       "Epoch end",
  epoch_transition:                "Epoch transit",
  forward:                         "Ledger fwd",
  prepare_block:                   "Block prep",
  ratification_context_new:        "Ratif ctx",
  reset_blocks_count:              "Blocks reset",
  reset_fees:                      "Fees reset",
  resolve_inputs:                  "Tx inputs",
  roll_backward:                   "Roll back",
  roll_forward:                    "Roll fwd",
  tick_pool:                       "Pool tick",
  tick_proposals:                  "Prop tick",
  validate_block:                  "Block valid",
  volatile_to_stable:              "Stable write",
  // network / peer manager
  accepted:                        "New conn",
  add_peer:                        "Peer add",
  connect:                         "Connecting",
  connection_died:                 "Conn died",
  manager_stage:                   "Mgr stage",
  remove_peer:                     "Peer remove",
  rollback_chain:                  "Chain rollback",
  roll_forward_chain:              "Chain fwd",
  store_block:                     "Block store",
  store_header:                    "Header store",
  // store operations
  dreps_delegation_remove:         "DRep deleg rm",
  prune:                           "Prune",
  snapshot:                        "Snapshot",
  try_epoch_transition:            "Epoch transit",
  accounts_add:                    "Accts add",
  accounts_get:                    "Accts read",
  accounts_remove:                 "Accts del",
  accounts_reset_delegation:       "Deleg reset",
  accounts_reset_many:             "Rewards reset",
  accounts_set:                    "Accts update",
  cc_members_upsert:               "CC update",
  dreps_add:                       "DReps add",
  dreps_get:                       "DReps read",
  dreps_remove:                    "DRep dereg",
  dreps_set_valid_until:           "DRep expiry",
  iter_scan:                       "Full scan",
  pools_add:                       "Pools add",
  pools_get:                       "Pools read",
  pools_remove:                    "Pool retire",
  pots_get:                        "Pots read",
  pots_put:                        "Pots write",
  proposals_add:                   "Props add",
  proposals_remove:                "Props remove",
  slots_get:                       "Slot read",
  slots_put:                       "Slot write",
  utxo_add:                        "UTxO add",
  utxo_get:                        "UTxO read",
  utxo_remove:                     "UTxO del",
  votes_add:                       "Votes add",
  commit:                          "Tx commit",
  rollback:                        "Tx rollback",
  save_point:                      "Checkpoint",
  validate_snapshots:              "Snapshots ok",
};

const NOISE_WORDS = new Set(["a", "an", "the", "to", "of", "for", "from", "at", "in", "on", "by", "and", "or"]);

function shortMetricLabel(name, description) {
  if (METRIC_SHORT_LABELS[name]) return METRIC_SHORT_LABELS[name];
  // Filter noise words, take first 2 meaningful words from description
  const words = (description || name.replace(/_/g, " ")).split(/\s+/);
  const meaningful = words.filter((w) => !NOISE_WORDS.has(w.toLowerCase()));
  return meaningful.slice(0, 2).join(" ") || words.slice(0, 2).join(" ");
}


function renderMetrics(snapshot) {
  const grid = document.querySelector("#metrics-grid");

  const syntheticMetrics = [
    {
      name: "rollbacks",
      description: "Rollbacks",
      shortLabel: "Rollbacks",
      unit: "ops",
      value: snapshot.counters.rollbacks,
      history: [snapshot.counters.rollbacks]
    }
  ];

  const allMetrics = [...snapshot.metrics.map((metric) => ({
    ...metric,
    history: snapshot.metricHistory[metric.name] || [],
    shortLabel: shortMetricLabel(metric.name, metric.description)
  })), ...syntheticMetrics]
    .sort((a, b) => a.name.localeCompare(b.name));

  // Accumulate known metrics for the picker (grows over time as new metrics arrive)
  allMetrics.forEach((m) => _allKnownMetrics.set(m.name, m.shortLabel));

  const selection = getMetricsSelection() ?? DEFAULT_METRICS;
  const metrics = allMetrics.filter((m) => selection.has(m.name));

  // rebuild DOM if metric keys changed
  const currentKeys = metrics.map((m) => m.name).join(",");
  if (grid.dataset.keys !== currentKeys) {
    grid.dataset.keys = currentKeys;
    grid.innerHTML = "";
    _countUpInstances.clear();

    metrics.forEach((metric, idx) => {

      const makeCard = (valueId, sparklineId) => {
        const el = document.createElement("article");
        const isGauge = isPercentMetric(metric);
        el.className = "metric-card" + (isGauge ? "" : " metric-card--plain");
        if (isGauge) {
          // Circular gauge badge
          const r = 34;
          const circ = 2 * Math.PI * r;
          el.innerHTML = `
              <div class="metric-card__circle">
                <svg class="metric-card__gauge" viewBox="0 0 80 80">
                  <circle class="metric-card__gauge-track" cx="40" cy="40" r="${r}"/>
                  <circle class="metric-card__gauge-fill" id="${sparklineId}-ring" cx="40" cy="40" r="${r}"
                    stroke-dasharray="${circ}" stroke-dashoffset="${circ}"/>
                </svg>
                <div class="metric-card__value-row">
                  <span id="${valueId}" class="metric-card__value">0</span>
                </div>
              </div>
              <p class="metric-card__label">${metric.shortLabel}</p>
            `;
        } else {
          // Plain badge (no circle)
          el.innerHTML = `
              <div class="metric-card__value-row">
                <span id="${valueId}" class="metric-card__value">0</span>
              </div>
              <p class="metric-card__label">${metric.shortLabel}</p>
            `;
        }
        return el;
      };
      const compactValueId = `mv-${idx}`;
      const compactSparkId = `msp-${idx}`;

      grid.append(makeCard(compactValueId, compactSparkId));

      const opts = { duration: 0.15, useEasing: false, useGrouping: false };
      const startVal = _lastKnownValue.get(metric.name) ?? 0;
      const cuCompact = new CountUp(compactValueId, startVal, opts);
      cuCompact.start();
      _countUpInstances.set(metric.name, { compact: cuCompact });
    });
  }

  // update values and sparklines
  metrics.forEach((metric, idx) => {
    const cu = _countUpInstances.get(metric.name);
    if (cu) {
      // Retain last non-zero value for all metrics so displays never jump to zero
      if (metric.value > 0) {
        _lastKnownValue.set(metric.name, metric.value);
      }
      let displayValue = _lastKnownValue.get(metric.name) ?? metric.value;

      const formatted = formatMetricValue({ ...metric, value: displayValue });
      if (formatted !== null) {
        const compactEl = document.querySelector(`#mv-${idx}`);
        if (compactEl) compactEl.textContent = formatted;
      } else {
        cu.compact.update(Math.round(displayValue));
      }
    }

    // animate gauge ring: percent metrics use value/100 directly (no history normalization)
    const ring = document.querySelector(`#msp-${idx}-ring`);
    if (ring) {
      const displayVal = _lastKnownValue.get(metric.name) ?? metric.value;
      const pct = Math.min(Math.max(displayVal / 100, 0), 1);
      const r = 34;
      const circ = 2 * Math.PI * r;
      ring.style.strokeDashoffset = circ * (1 - pct);
    }


  });
}

function renderFeed(target, entries, formatter) {
  const node = document.querySelector(target);

  // Build a key for each entry to detect which are genuinely new
  const keyOf = (e) => e.id ?? `${e.tag}:${e.title}:${e.timestamp}`;
  const existingKeys = new Set(
    [...node.querySelectorAll("li[data-key]")].map((el) => el.dataset.key)
  );

  // Remove items that are no longer in the list
  const incomingKeys = new Set(entries.map(keyOf));
  node.querySelectorAll("li[data-key]").forEach((el) => {
    if (!incomingKeys.has(el.dataset.key)) el.remove();
  });

  // Prepend new items in reverse order so newest ends up on top
  const newEntries = entries.filter((e) => !existingKeys.has(keyOf(e)));
  [...newEntries].reverse().forEach((entry) => {
    const item = document.createElement("li");
    item.className = "feed-item feed-item--new";
    item.dataset.key = keyOf(entry);
    item.innerHTML = formatter(entry);
    node.prepend(item);
    // Remove animation class after it completes so re-renders are clean
    item.addEventListener("animationend", () => item.classList.remove("feed-item--new"), { once: true });
  });

  // Re-order to match sorted entries and silently update content of existing items
  entries.forEach((entry) => {
    const key = keyOf(entry);
    const el = node.querySelector(`li[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    if (existingKeys.has(key)) {
      // Update content without animation (stage label change, etc.)
      el.innerHTML = formatter(entry);
    }
    node.append(el);
  });
}

let _eventsThrottleTimer = null;
let _pendingEventsSnapshot = null;

function flushEvents() {
  _eventsThrottleTimer = null;
  if (!_pendingEventsSnapshot) return;
  const snapshot = _pendingEventsSnapshot;
  _pendingEventsSnapshot = null;
  _renderEventsFull(snapshot);
}

function renderEvents(snapshot) {
  _pendingEventsSnapshot = snapshot;
  if (!_eventsThrottleTimer) {
    _eventsThrottleTimer = setTimeout(flushEvents, 2000);
  }
}

function _renderEventsFull(snapshot) {
  const blockEvents = snapshot.blocks.map((b) => ({
    id: `block:${b.hash}`,
    title: `Block #${b.number}`,
    detail: `${b.stage} · slot ${b.slot ?? "--"} · ${truncateMiddle(b.hash, 8, 6)}`,
    timestamp: b.updatedAt,
    tag: "block"
  }));
  const peerEvts = snapshot.peerEvents.map((e) => ({ ...e, tag: "peer" }));
  const opsEvts = snapshot.ops.map((e) => ({ ...e, tag: "ops" }));

  // Deduplicate by key before rendering to avoid duplicate-key collisions
  const keyOf = (e) => e.id ?? `${e.tag}:${e.title}:${e.timestamp}`;
  const seen = new Set();
  const all = [...blockEvents, ...peerEvts, ...opsEvts]
    .sort((a, b) => b.timestamp - a.timestamp)
    .filter((e) => { const k = keyOf(e); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 20);

  const tagLabel = { block: "block", peer: "peer", ops: "governance" };
  renderFeed("#peer-feed", all, (event) => `
    <div class="feed-item__headline">${event.title} <span class="feed-item__tag feed-item__tag--${event.tag}">${tagLabel[event.tag]}</span></div>
    <div class="feed-item__detail">${event.detail}</div>
  `);
}

function renderOps(snapshot) {
  document.querySelector("#rollback-count").textContent = snapshot.counters.rollbacks;
  document.querySelector("#stable-count").textContent = snapshot.counters.stableWrites;
  document.querySelector("#vote-count").textContent = snapshot.counters.votes;
  document.querySelector("#transition-count").textContent = snapshot.counters.epochTransitions;
}

function renderPixelMaps(snapshot) {
  const peerCanvas = document.querySelector("#peer-map-canvas");
  const peerCtx = peerCanvas.getContext("2d");

  peerCtx.fillStyle = "#f1efe7";
  peerCtx.fillRect(0, 0, peerCanvas.width, peerCanvas.height);

  for (const peer of snapshot.peers) {
    if (!Number.isFinite(peer.latitude) || !Number.isFinite(peer.longitude)) {
      continue;
    }

    const x = ((peer.longitude + 180) / 360) * peerCanvas.width;
    const y = ((90 - peer.latitude) / 180) * peerCanvas.height;
    peerCtx.fillStyle = peer.status === "active" ? "#66ff00" : "#294dff";
    peerCtx.fillRect(Math.floor(x / 8) * 8, Math.floor(y / 8) * 8, 6, 6);
  }

  if (snapshot.peers.length === 0) {
    drawNoData(peerCtx, peerCanvas.width, peerCanvas.height);
  }
}

function drawNoData(ctx, w, h) {
  ctx.save();
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.letterSpacing = "0.08em";
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("NO DATA RECEIVED YET", w / 2, h / 2);
  ctx.restore();
}

async function refreshPeerGeo(snapshot, store, config) {
  await Promise.all(
    snapshot.peers
      .filter((peer) => !Number.isFinite(peer.latitude) || !Number.isFinite(peer.longitude))
      .slice(0, 3)
      .map(async (peer) => {
        const geo = await geolocatePeer(peer.peer, config);
        store.updatePeerGeo(peer.peer, geo);
      })
  );
}

function renderPeerTable(snapshot) {
  const tbody = document.querySelector("#peer-table-body");
  if (!tbody) return;
  tbody.innerHTML = snapshot.peers.map((p) => {
    const hasGeo = Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
    const city = p.cityName && p.cityName !== "derived" ? p.cityName : "—";
    const country = p.countryName && p.countryName !== "fallback" ? p.countryName : "—";
    const latLon = hasGeo ? `${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}` : "—";
    const source = p.source ?? "—";
    return `<tr>
      <td style="font-family:var(--font-mono);font-size:0.78rem">${p.peer}</td>
      <td><span class="peer-status peer-status--${p.status}">${p.status}</span></td>
      <td>${city}</td>
      <td>${country}</td>
      <td style="font-family:var(--font-mono);font-size:0.78rem">${latLon}</td>
      <td>${source}</td>
    </tr>`;
  }).join("");
}

export async function createDashboard() {
  const config = readRuntimeConfig();
  await initEraHistory();
  const store = createStateStore(config.network);
  const globe = createGlobe(document.querySelector("#globe-scene"), config);

  // ── Globe flip ──────────────────────────────────────────────────────────────
  const globeFlipper = document.querySelector("#globe-flipper");
  document.querySelector("#globe-flip-btn").addEventListener("click", () => {
    globeFlipper.classList.add("is-flipped");
  });
  document.querySelector("#globe-flip-back-btn").addEventListener("click", () => {
    globeFlipper.classList.remove("is-flipped");
  });


  const settingsBtn = document.querySelector("#metrics-settings-btn");
  const picker = document.querySelector("#metrics-picker");
  const pickerList = document.querySelector("#metrics-picker-list");
  const pickerReset = document.querySelector("#metrics-picker-reset");

  function populatePicker() {
    const selection = getMetricsSelection() ?? DEFAULT_METRICS;
    pickerList.innerHTML = "";
    [..._allKnownMetrics.entries()]
      .sort((a, b) => (a[1] || a[0]).localeCompare(b[1] || b[0]))
      .forEach(([name, label]) => {
        const li = document.createElement("li");
        li.className = "metrics-picker__item";
        const id = `mp-${name}`;
        li.innerHTML = `<label class="metrics-picker__label"><input type="checkbox" value="${name}"${selection.has(name) ? " checked" : ""}> ${label || name}</label>`;
        pickerList.append(li);
      });
  }

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = picker.hidden;
    picker.hidden = !isHidden;
    if (!picker.hidden) populatePicker();
  });

  pickerList.addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const selection = getMetricsSelection() ?? new Set(DEFAULT_METRICS);
    if (e.target.checked) selection.add(e.target.value);
    else selection.delete(e.target.value);
    saveMetricsSelection(selection);
    // Force grid rebuild on next render
    const grid = document.querySelector("#metrics-grid");
    grid.dataset.keys = "";
  });

  pickerReset.addEventListener("click", () => {
    localStorage.removeItem(METRICS_STORAGE_KEY);
    const grid = document.querySelector("#metrics-grid");
    grid.dataset.keys = "";
    populatePicker();
  });

  document.addEventListener("click", (e) => {
    if (!picker.hidden && !picker.contains(e.target) && e.target !== settingsBtn) {
      picker.hidden = true;
    }
  });


  let _lastCelebrationEpoch = null;
  let _lastCelebrationAt = 0;
  const CELEBRATION_COOLDOWN_MS = 30_000;

  store.subscribe((snapshot) => {
    document.body.classList.toggle("no-data", !snapshot.hasData);
    setConnectionState(snapshot);

    // Epoch crossing detection — skip on the very first snapshot to avoid
    // a false celebration on page load. Also enforce a cooldown so that
    // rapid epoch transitions during node sync don't spam celebrations.
    const currentEpochNum = snapshot.currentEpoch?.epoch ?? null;
    const now = Date.now();
    if (
      currentEpochNum !== null &&
      _lastCelebrationEpoch !== null &&
      currentEpochNum > _lastCelebrationEpoch &&
      now - _lastCelebrationAt >= CELEBRATION_COOLDOWN_MS
    ) {
      triggerEpochCelebration(currentEpochNum);
      _lastCelebrationAt = now;
    }
    if (currentEpochNum !== null) _lastCelebrationEpoch = currentEpochNum;
    renderHero(snapshot);
    renderMetrics(snapshot);
    renderEvents(snapshot); // throttled internally to 2s
    renderOps(snapshot);
    renderPeerTable(snapshot);
    globe.render(snapshot);
    refreshPeerGeo(snapshot, store, config).catch(console.warn);
    // Keep globe counters live even while feed is throttled
    document.querySelector("#globe-peer-total").textContent = `${snapshot.peers.length} peers`;
  });

  store.setConnectionState({ kind: "connecting", label: describeSource(config) });

  const stopStream = connectToStream(config, {
    onMessage: (message) => store.ingestMessage(message),
    onState: (connectionState) => store.setConnectionState(connectionState)
  });

  window.addEventListener("beforeunload", stopStream, { once: true });
}