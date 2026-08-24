use amaru_kernel::{Epoch, Slot, MAINNET_ERA_HISTORY, PREPROD_ERA_HISTORY, PREVIEW_ERA_HISTORY};
use wasm_bindgen::prelude::*;

/// Returns a JSON string describing epoch progress for the given slot, or `undefined` when the
/// slot is outside the known era history (e.g. past the time horizon).
///
/// The returned JSON has the shape:
/// ```json
/// { "epoch": 186, "slotInEpoch": 73728, "epochSizeSlots": 432000, "progress": 0.17, "nextEpochSlot": 123456 }
/// ```
#[wasm_bindgen]
pub fn describe_epoch_progress(network: &str, slot: u64, tip_slot: u64) -> Option<String> {
    let history = match network {
        "mainnet" => &*MAINNET_ERA_HISTORY,
        "preprod" => &*PREPROD_ERA_HISTORY,
        "preview" => &*PREVIEW_ERA_HISTORY,
        _ => return None,
    };

    let slot_v = Slot::from(slot);
    let tip_v = Slot::from(tip_slot);

    let epoch = history.slot_to_epoch(slot_v, tip_v).ok()?;
    let slot_in_epoch: u64 = history.slot_in_epoch(slot_v, tip_v).ok()?.into();

    // We compute epoch_size_slots and next_epoch_slot from consecutive epoch bounds.
    // epoch_bounds does not check the time horizon, so this works for all eras including Conway
    // (which has no declared end slot in the era history).
    let epoch_u64: u64 = epoch.into();
    let bounds = history.epoch_bounds(epoch).ok()?;
    let bounds_next = history.epoch_bounds(Epoch::from(epoch_u64 + 1)).ok()?;

    let epoch_start: u64 = bounds.start.into();
    let next_epoch_slot: u64 = bounds_next.start.into();
    let epoch_size_slots = next_epoch_slot - epoch_start;
    let progress = slot_in_epoch as f64 / epoch_size_slots as f64;

    Some(format!(
        r#"{{"epoch":{},"slotInEpoch":{},"epochSizeSlots":{},"progress":{},"nextEpochSlot":{}}}"#,
        epoch_u64, slot_in_epoch, epoch_size_slots, progress, next_epoch_slot
    ))
}
