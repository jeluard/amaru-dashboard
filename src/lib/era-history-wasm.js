// Wrapper around the amaru-kernel WASM module for era-history calculations.
// Call initEraHistory() once (async) before invoking describeEpochProgress().
import init, { describe_epoch_progress as wasmDescribeEpochProgress } from "../../wasm/pkg/amaru_kernel_wasm.js";
// Import the WASM binary via esbuild's file loader so it's copied to dist/ with a hash.
import wasmPath from "../../wasm/pkg/amaru_kernel_wasm_bg.wasm";

let _ready = false;

export async function initEraHistory() {
  if (_ready) return;
  // Resolve the path relative to this module so fetch() gets an absolute URL
  // regardless of the document's base URL.
  const wasmUrl = new URL(wasmPath, import.meta.url);
  await init(wasmUrl);
  _ready = true;
}

/**
 * Returns epoch progress for the given absolute slot, or null when the slot is
 * outside the known era history.
 *
 * @param {string} networkName  "mainnet" | "preprod" | "preview" | "testnet"
 * @param {number} slot
 * @param {number} [tipSlot]
 * @returns {{ epoch, slotInEpoch, epochSizeSlots, progress, nextEpochSlot } | null}
 */
export function describeEpochProgress(networkName, slot, tipSlot = slot) {
  if (!_ready) {
    console.warn("describeEpochProgress called before WASM initialisation");
    return null;
  }
  const raw = wasmDescribeEpochProgress(networkName, BigInt(slot), BigInt(tipSlot));
  return raw ? JSON.parse(raw) : null;
}
