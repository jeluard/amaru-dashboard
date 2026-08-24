// Public observability identities from Amaru's current main schema.
// Amaru targets contain the first two schema path segments; the rest is part
// of the event name (for example `amaru::ledger` + `tip.update`).
export const AMARU_EVENTS = Object.freeze({
  tipUpdate: ["amaru::ledger", "tip.update"],
  blockAdopt: ["amaru::consensus", "tip.adopt"],
  epochTransition: ["amaru::ledger", "epoch_transition.compute"],
  chainSwitchToFork: ["amaru::ledger", "state.switch_to_fork"],
  validationContextCreate: ["amaru::ledger", "block_validation_context.create"],
  blockPrepare: ["amaru::ledger", "block.prepare"],
  blockApply: ["amaru::ledger", "block.apply"],
  blockStore: ["amaru::stores", "consensus.block.store"],
  headerStore: ["amaru::stores", "consensus.header.store"],
  voteStore: ["amaru::stores", "ledger.votes.add"],
  mempoolUpdate: ["amaru::mempool", "state.update"],
  transactionAccepted: ["amaru::mempool", "transaction.accepted"],
  transactionRejected: ["amaru::mempool", "transaction.rejected"],
  transactionEvicted: ["amaru::mempool", "transaction.evicted"],
  peerConnected: ["amaru::protocols", "peer_selection.peer.connected"],
  peerDisconnected: ["amaru::protocols", "peer_selection.peer.disconnected"],
});

export function isAmaruEvent(record, [target, name]) {
  if (record.target === target && record.name === name) return true;

  // otel-ui currently exposes an OTLP log's event name as `body`, but does
  // not retain its target. Amaru event names include their remaining schema
  // path, making them specific enough for the events tracked above.
  return record.body === name;
}

export function telemetryRecords(message) {
  if (message.type === "spans_batch") return message.spans || [];
  if (message.type === "logs_batch") return message.logs || [];
  return [];
}
