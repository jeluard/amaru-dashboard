import { describeEpochProgress } from "./era-history-wasm.js";
import { AMARU_EVENTS, isAmaruEvent, telemetryRecords } from "./events.js";
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
      txCount: null,
      sizeBytes: null,
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

function applyPeerEvent(state, record, attributes) {
  const peer = attributes.peer;

  const connected = isAmaruEvent(record, AMARU_EVENTS.peerConnected);
  const disconnected = isAmaruEvent(record, AMARU_EVENTS.peerDisconnected);
  if (!peer || (!connected && !disconnected)) {
    return;
  }

  const peerState = ensurePeer(state, peer);
  peerState.lastSeenAt = now();

  if (connected) {
    peerState.status = "active";
    peerState.connections += 1;
    state.liveArcs = pushEvent(state.liveArcs, {
      peer,
      status: "active",
      startedAt: now(),
      connId: attributes.conn_id || ""
    }, 18);
  } else {
    peerState.status = "disconnected";
    peerState.connections = Math.max(0, peerState.connections - 1);
    state.liveArcs = pushEvent(state.liveArcs, {
      peer,
      status: "error",
      startedAt: now(),
      connId: attributes.conn_id || ""
    }, 18);
  }

  state.peerEvents = pushEvent(state.peerEvents, {
    title: connected ? "peer connected" : "peer disconnected",
    detail: `${peer}${attributes.reason ? ` · ${attributes.reason}` : ""}`,
    timestamp: now(),
    tone: peerState.status
  });
}

function updateCurrentBlock(state, record, attributes) {
  if (isAmaruEvent(record, AMARU_EVENTS.tipUpdate)) {
    const block = {
      number: Number(attributes.block_height),
      hash: attributes.header_hash,
      bodySize: null,
      totalInputs: Number(attributes.tx_count || 0),
      slot: Number(attributes.slot),
      stage: "adopted",
      updatedAt: now(),
      stages: ["adopted"]
    };
    state.currentBlock = block;
    state.blocks = pushEvent(state.blocks.filter((item) => item.hash !== block.hash), block, 10);
    return;
  }

  if (isAmaruEvent(record, AMARU_EVENTS.validationContextCreate)) {
    const block = {
      number: Number(attributes.block_number),
      hash: attributes.block_id,
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

  const stage = [
    [AMARU_EVENTS.blockPrepare, "prepare"],
    [AMARU_EVENTS.blockApply, "apply"],
    [AMARU_EVENTS.blockStore, "store block"],
    [AMARU_EVENTS.headerStore, "store header"]
  ].find(([event]) => isAmaruEvent(record, event));
  if (!stage) return;

  const stageName = stage[1];
  state.currentBlock.stage = stageName;
  state.currentBlock.updatedAt = now();

  if (!state.currentBlock.stages.includes(stageName)) {
    state.currentBlock.stages.push(stageName);
  }

  if (isAmaruEvent(record, AMARU_EVENTS.blockApply) && Number.isFinite(Number(attributes.point_slot))) {
    state.tipSlot = Number(attributes.point_slot);
    state.currentBlock.slot = state.tipSlot;
  }

  if (isAmaruEvent(record, AMARU_EVENTS.blockStore) && attributes.hash) {
    state.currentBlock.hash = attributes.hash;
  }

  state.blocks = [state.currentBlock, ...state.blocks.filter((block) => block.hash !== state.currentBlock.hash)].slice(0, 10);
}

function applyOperationalEvent(state, record, attributes) {
  let title;
  let detail;
  let tone = "info";

  if (isAmaruEvent(record, AMARU_EVENTS.chainSwitchToFork)) {
    title = "chain switched to fork";
    state.counters.rollbacks += 1;
    detail = `${attributes.fork_point || "unknown point"} · ${attributes.rollback_length || 0} blocks`;
    tone = "error";
  } else if (isAmaruEvent(record, AMARU_EVENTS.blockApply)) {
    title = "block applied";
    state.counters.stableWrites += 1;
    detail = attributes.point_slot || "unknown slot";
    tone = "success";
  } else if (isAmaruEvent(record, AMARU_EVENTS.voteStore)) {
    title = "votes stored";
    state.counters.votes += 1;
    detail = "ledger votes updated";
  } else if (isAmaruEvent(record, AMARU_EVENTS.epochTransition)) {
    title = "epoch transition";
    state.counters.epochTransitions += 1;
    detail = `${attributes.from || "?"} -> ${attributes.into || "?"}`;
  } else {
    return;
  }

  state.ops = pushEvent(state.ops, { title, detail, timestamp: now(), tone }, 10);
}

function applyMempoolEvent(state, record, attributes) {
  if (isAmaruEvent(record, AMARU_EVENTS.mempoolUpdate)) {
    state.mempool.txCount = Number(attributes.tx_count);
    state.mempool.sizeBytes = Number(attributes.size_bytes);
    return;
  }

  const txId = attributes.id || "";
  if (isAmaruEvent(record, AMARU_EVENTS.transactionAccepted)) {
    state.mempool.accepted += 1;
    const origin = attributes.origin || "";
    state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
      title: "accepted",
      detail: `${txId}${origin ? " · " + origin : ""}`,
      timestamp: now(),
      tone: "success"
    }, 15);
  } else if (isAmaruEvent(record, AMARU_EVENTS.transactionRejected)) {
    state.mempool.rejected += 1;
    const reason = attributes.reason || "unknown";
    state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
      title: "rejected",
      detail: `${txId} · ${reason}`,
      timestamp: now(),
      tone: "error"
    }, 15);
  } else if (isAmaruEvent(record, AMARU_EVENTS.transactionEvicted)) {
    state.mempool.evicted += 1;
    const reason = attributes.reason || "";
    state.mempool.recentEvents = pushEvent(state.mempool.recentEvents, {
      title: "evicted",
      detail: `${txId}${reason ? " · " + reason : ""}`,
      timestamp: now(),
      tone: "warn"
    }, 15);
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

      const records = telemetryRecords(message);
      if (records.length === 0) {
        return;
      }

      state.counters.spansSeen += records.length;

      for (const record of records) {
        const attributes = toAttributesObject(record.attributes);

        if (isAmaruEvent(record, AMARU_EVENTS.tipUpdate)) {
          state.tipSlot = Number(attributes.slot);
          const derived = describeEpochProgress(state.network, state.tipSlot, state.tipSlot);
          state.currentEpoch = derived
            ? {
                ...derived,
                epoch: Number(attributes.epoch),
                slotInEpoch: Number(attributes.slot_in_epoch)
              }
            : {
                epoch: Number(attributes.epoch),
                slotInEpoch: Number(attributes.slot_in_epoch),
                epochSizeSlots: state.currentEpoch?.epochSizeSlots || 432000,
                progress: state.currentEpoch?.progress || 0,
                nextEpochSlot: state.currentEpoch?.nextEpochSlot || 0
              };
        }

        applyMempoolEvent(state, record, attributes);
        applyPeerEvent(state, record, attributes);
        updateCurrentBlock(state, record, attributes);
        applyOperationalEvent(state, record, attributes);
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
