import { describeEpochProgress } from "./era-history-wasm.js";
import { now, toAttributesObject } from "./utils.js";

function trimList(list, maxSize) {
  if (list.length <= maxSize) {
    return list;
  }

  return list.slice(0, maxSize);
}

function createEmptyState(network) {
  return {
    network,
    tipSlot: null,
    currentBlock: null,
    currentEpoch: null,
    connectionState: { kind: "idle", label: "probing local websocket endpoints" },
    firstDataAt: null,
    lastMessageAt: null,
    peers: new Map(),
    peerEvents: [],
    blocks: [],
    ops: [],
    metrics: new Map(),
    metricHistory: new Map(),
    counters: {
      rollbacks: 0,
      stableWrites: 0,
      votes: 0,
      epochTransitions: 0,
      spansSeen: 0,
      metricsSeen: 0
    },
    liveArcs: [],
    mempool: {
      accepted: 0,
      rejected: 0,
      evicted: 0,
      recentEvents: []
    }
  };
}

function ensurePeer(state, peer) {
  if (!state.peers.has(peer)) {
    state.peers.set(peer, {
      peer,
      status: "known",
      cityName: "Locating",
      countryName: "",
      latitude: null,
      longitude: null,
      lastSeenAt: now(),
      connections: 0
    });
  }

  return state.peers.get(peer);
}

function pushEvent(list, event, maxSize = 14) {
  list.unshift(event);
  return trimList(list, maxSize);
}

function applyPeerEvent(state, span, attributes) {
  const peer = attributes.peer;

  if (!peer) {
    return;
  }

  const peerState = ensurePeer(state, peer);
  peerState.lastSeenAt = now();

  switch (span.name) {
    case "add_peer":
      peerState.status = "known";
      break;
    case "connect":
      peerState.status = "connecting";
      break;
    case "accepted":
      peerState.status = "active";
      peerState.connections += 1;
      state.liveArcs = pushEvent(state.liveArcs, {
        peer,
        status: "active",
        startedAt: now(),
        connId: attributes.conn_id || ""
      }, 18);
      break;
    case "connection_died":
      peerState.status = "disconnected";
      peerState.connections = Math.max(0, peerState.connections - 1);
      state.liveArcs = pushEvent(state.liveArcs, {
        peer,
        status: "error",
        startedAt: now(),
        connId: attributes.conn_id || ""
      }, 18);
      break;
    case "remove_peer":
      peerState.status = "removed";
      break;
    default:
      break;
  }

  state.peerEvents = pushEvent(state.peerEvents, {
    title: span.name.replaceAll("_", " "),
    detail: peer,
    timestamp: now(),
    tone: peerState.status
  });
}

function updateCurrentBlock(state, span, attributes) {
  const trackedStages = new Set([
    "create_validation_context",
    "prepare_block",
    "validate_block",
    "apply_block",
    "store_block",
    "store_header",
    "volatile_to_stable"
  ]);

  if (!trackedStages.has(span.name)) {
    return;
  }

  if (span.name === "create_validation_context") {
    const block = {
      number: Number(attributes.block_number),
      hash: attributes.block_body_hash,
      bodySize: Number(attributes.block_body_size),
      totalInputs: Number(attributes.total_inputs || 0),
      slot: state.tipSlot,
      stage: "validation context",
      updatedAt: now(),
      stages: ["validation context"]
    };
    state.currentBlock = block;
    state.blocks = pushEvent(state.blocks, block, 10);
    return;
  }

  if (!state.currentBlock) {
    return;
  }

  const stageName = span.name.replaceAll("_", " ");
  state.currentBlock.stage = stageName;
  state.currentBlock.updatedAt = now();

  if (!state.currentBlock.stages.includes(stageName)) {
    state.currentBlock.stages.push(stageName);
  }

  if (span.name === "apply_block" && Number.isFinite(Number(attributes.point_slot))) {
    state.tipSlot = Number(attributes.point_slot);
    state.currentBlock.slot = state.tipSlot;
  }

  if (span.name === "store_block" && attributes.hash) {
    state.currentBlock.hash = attributes.hash;
  }

  state.blocks = [state.currentBlock, ...state.blocks.filter((block) => block.hash !== state.currentBlock.hash)].slice(0, 10);
}

function applyOperationalEvent(state, span, attributes) {
  const title = span.name.replaceAll("_", " ");
  let detail = span.target;
  let tone = "info";

  if (span.name === "rollback_chain") {
    state.counters.rollbacks += 1;
    detail = `${attributes.slot || "unknown slot"} ${attributes.hash || ""}`.trim();
    tone = "error";
  }

  if (span.name === "volatile_to_stable") {
    state.counters.stableWrites += 1;
    detail = attributes.persisted_point || "persisted block";
    tone = "success";
  }

  if (span.name === "vote") {
    state.counters.votes += 1;
    detail = `${attributes.voter_type || "voter"} ${attributes.credential_hash || ""}`.trim();
  }

  if (span.name === "epoch_transition") {
    state.counters.epochTransitions += 1;
    detail = `${attributes.from || "?"} -> ${attributes.into || "?"}`;
  }

  state.ops = pushEvent(state.ops, { title, detail, timestamp: now(), tone }, 10);
}

function applyMempoolSpan(state, span, attributes) {
  const txId = attributes.tx_id || "";
  switch (span.name) {
    case "tx_accepted": {
      state.mempool.accepted += 1;
      const origin = attributes.origin || "";
      state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
        title: "accepted",
        detail: `${txId}${origin ? " · " + origin : ""}`,
        timestamp: now(),
        tone: "success"
      }, 15);
      break;
    }
    case "tx_rejected": {
      state.mempool.rejected += 1;
      const reason = attributes.reason || "unknown";
      state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
        title: "rejected",
        detail: `${txId} · ${reason}`,
        timestamp: now(),
        tone: "error"
      }, 15);
      break;
    }
    case "tx_evicted": {
      state.mempool.evicted += 1;
      const reason = attributes.reason || "";
      state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
        title: "evicted",
        detail: `${txId}${reason ? " · " + reason : ""}`,
        timestamp: now(),
        tone: "warn"
      }, 15);
      break;
    }
  }
}

function applyMetricBatch(state, metrics) {
  state.counters.metricsSeen += metrics.length;

  for (const metric of metrics) {
    const numericValue = metric.value.kind === "histogram"
      ? metric.value.count === 0 ? 0 : metric.value.sum / metric.value.count
      : metric.value.value;

    state.metrics.set(metric.metric_name, {
      name: metric.metric_name,
      description: metric.description,
      unit: metric.unit,
      value: numericValue,
      updatedAt: now()
    });

    const history = state.metricHistory.get(metric.metric_name) || [];
    history.push(numericValue);
    state.metricHistory.set(metric.metric_name, history.slice(-16));
  }
}

export function createStateStore(network) {
  const state = createEmptyState(network);
  const listeners = new Set();

  function emit() {
    const snapshot = snapshotState(state);
    listeners.forEach((listener) => listener(snapshot));
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshotState(state));
      return () => listeners.delete(listener);
    },
    setConnectionState(connectionState) {
      state.connectionState = connectionState;
      emit();
    },
    updatePeerGeo(peer, geo) {
      const peerState = ensurePeer(state, peer);
      Object.assign(peerState, geo, { lastSeenAt: now() });
      emit();
    },
    ingestMessage(message) {
      state.lastMessageAt = now();
      state.firstDataAt = state.firstDataAt || state.lastMessageAt;

      if (message.type === "metrics_batch") {
        applyMetricBatch(state, message.metrics || []);
        emit();
        return;
      }

      if (message.type !== "spans_batch") {
        return;
      }

      state.counters.spansSeen += (message.spans || []).length;

      for (const span of message.spans || []) {
        const attributes = toAttributesObject(span.attributes);

        if (span.name === "apply_block" && Number.isFinite(Number(attributes.point_slot))) {
          state.tipSlot = Number(attributes.point_slot);
          state.currentEpoch = describeEpochProgress(state.network, state.tipSlot, state.tipSlot);
        }

        if (span.target === "amaru::mempool") {
          applyMempoolSpan(state, span, attributes);
        }

        if (span.target === "amaru::protocols::manager") {
          applyPeerEvent(state, span, attributes);
        }

        if (span.target === "amaru::ledger::state" || span.target === "amaru::stores::consensus") {
          updateCurrentBlock(state, span, attributes);
        }

        if (
          span.name === "rollback_chain" ||
          span.name === "volatile_to_stable" ||
          span.name === "vote" ||
          span.name === "epoch_transition"
        ) {
          applyOperationalEvent(state, span, attributes);
        }

        if (span.name === "epoch_transition") {
          state.currentEpoch = {
            epoch: Number(attributes.into),
            slotInEpoch: 0,
            epochSizeSlots: state.currentEpoch?.epochSizeSlots || 432000,
            progress: 0,
            nextEpochSlot: state.currentEpoch?.nextEpochSlot || 0
          };
        }
      }

      if (state.tipSlot != null) {
        state.currentEpoch = describeEpochProgress(state.network, state.tipSlot, state.tipSlot) || state.currentEpoch;
      }

      emit();
    }
  };
}

function snapshotState(state) {
  const peers = [...state.peers.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const metrics = [...state.metrics.values()].sort((left, right) => left.name.localeCompare(right.name));
  const metricHistory = Object.fromEntries(state.metricHistory.entries());

  return {
    network: state.network,
    tipSlot: state.tipSlot,
    currentBlock: state.currentBlock,
    currentEpoch: state.currentEpoch,
    connectionState: state.connectionState,
    hasData: Boolean(state.firstDataAt),
    firstDataAt: state.firstDataAt,
    lastMessageAt: state.lastMessageAt,
    peers,
    peerEvents: state.peerEvents,
    blocks: state.blocks,
    ops: state.ops,
    metrics,
    metricHistory,
    counters: { ...state.counters },
    liveArcs: state.liveArcs.filter((arc) => now() - arc.startedAt < 12000),
    mempool: { ...state.mempool, recentEvents: state.mempool.recentEvents }
  };
}