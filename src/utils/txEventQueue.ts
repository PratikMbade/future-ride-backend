// src/utils/txEventQueue.ts
//
// Fixes a real ordering bug: a single registration transaction emits
// RegisterEV + PackageBuyEV + DirectPayEV + GenerationPayEV (and
// potentially UpgradeHolding/LapsPayEV) all in ONE transaction. Each
// event arrives over the WebSocket as an independent `contract.on(...)`
// callback fire — there's no guarantee about which callback's async
// handler actually finishes first. In practice PackageBuyEV's handler
// was sometimes running BEFORE RegisterEV's had finished creating the
// user row, causing "User not found in DB" failures.
//
// sync.service.ts doesn't have this problem because it fetches a whole
// block range up front and explicitly processes phases in order with
// await between each phase. Live listeners can't do that the same way
// since each event is pushed independently — so instead, every event
// for a given txHash is buffered into a per-transaction queue, and
// processed in a FIXED priority order once we have a moment to flush,
// regardless of the order they actually arrived on the wire.
//
// Priority order (matches sync.service.ts's processBatch order exactly):
//   1. RegisterEV        — must create the user row before anything else
//   2. PackageBuyEV / PackageUpgradeEV
//   3. DirectPayEV
//   4. GenerationPayEV
//   5. LapsPayEV
//   6. UpgradeHolding

type QueuedHandler = () => Promise<void>;

interface QueuedEvent {
  priority: number;
  label:    string;
  handler:  QueuedHandler;
}

const PRIORITY: Record<string, number> = {
  RegisterEV:        1,
  PackageBuyEV:      2,
  PackageUpgradeEV:  2,
  DirectPayEV:       3,
  GenerationPayEV:   4,
  LapsPayEV:         5,
  UpgradeHolding:    6,
};

// txHash -> events waiting to be flushed, plus a timer so we don't flush
// on every single push (multiple events for the same tx arrive within
// milliseconds of each other — we want to batch them, not race per-event)
const pendingByTx = new Map<string, QueuedEvent[]>();
const flushTimers = new Map<string, NodeJS.Timeout>();

// How long to wait after the FIRST event for a given txHash before
// assuming all of that transaction's events have arrived. 1.5s is
// generous — Alchemy WSS pushes for the same tx typically land within
// a few hundred ms of each other, but block propagation/processing can
// occasionally stagger slightly more than that.
const FLUSH_DELAY_MS = 1500;

async function flush(txHash: string): Promise<void> {
  const events = pendingByTx.get(txHash);
  pendingByTx.delete(txHash);
  flushTimers.delete(txHash);

  if (!events || events.length === 0) return;

  // sort by priority — lower number = runs first, regardless of arrival order
  events.sort((a, b) => a.priority - b.priority);

  for (const evt of events) {
    try {
      await evt.handler();
    } catch (err: any) {
      console.error(`[txEventQueue] ${evt.label} handler failed for tx ${txHash}:`, err.message);
      // continue processing the rest of this tx's events even if one fails —
      // matches the existing per-event try/catch pattern already used
      // throughout event-listener.ts, where one failure shouldn't block others
    }
  }
}

/**
 * Queue an event handler to run in priority order alongside any other
 * events sharing the same transaction hash. Call this from inside each
 * contract.on(...) callback instead of running the handler immediately.
 */
export function queueTxEvent(
  txHash:  string,
  label:   keyof typeof PRIORITY,
  handler: QueuedHandler,
): void {
  const priority = PRIORITY[label] ?? 99; // unknown event types run last

  const existing = pendingByTx.get(txHash) ?? [];
  existing.push({ priority, label, handler });
  pendingByTx.set(txHash, existing);

  // reset the flush timer each time a new event arrives for this tx —
  // this means flush fires FLUSH_DELAY_MS after the LAST event for this
  // tx arrives, not the first, giving slow-arriving siblings more room
  const existingTimer = flushTimers.get(txHash);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    flush(txHash).catch(err =>
      console.error(`[txEventQueue] flush failed for tx ${txHash}:`, err.message)
    );
  }, FLUSH_DELAY_MS);

  flushTimers.set(txHash, timer);
}