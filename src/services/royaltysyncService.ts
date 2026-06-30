

import { ethers } from 'ethers';
import { prisma } from '..';
import { royaltyIncomeService } from './royaltyincome.service';
import royaltyContractAbi from '../contract/royalty-contract/royalty-abi.json'; // ASSUMPTION: same path as the listener — adjust to match your actual file location
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);
const contract = new ethers.Contract(
  process.env.ROYALTY_CONTRACT_ADDRESS!,
  royaltyContractAbi,
  provider
);

// Same batch size reasoning as sync.service.ts — Alchemy's BNB mainnet
// tier rejects wide eth_getLogs ranges even under 2000 blocks.
const BATCH_SIZE = 500;

// ─── safe queryFilter wrapper — identical retry/split logic to
//     sync.service.ts's own safeQueryFilter, duplicated here rather
//     than imported since this is intentionally a fully independent
//     sync process, not coupled to the main one ───────────────────────
async function safeQueryFilter(
  filter:    ethers.EventFilter,
  fromBlock: number,
  toBlock:   number,
  depth = 0,
): Promise<ethers.Event[]> {
  try {
    return await contract.queryFilter(filter, fromBlock, toBlock);
  } catch (err: any) {
    const isRangeError =
      err?.code === 'SERVER_ERROR' &&
      (err?.error?.code === -32000 || /invalid block range/i.test(err?.error?.message ?? ''));

    if (isRangeError && fromBlock < toBlock && depth < 8) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      console.warn(`⚠️  [RoyaltySync] Range rejected (${fromBlock}-${toBlock}, depth ${depth}) — splitting at ${mid}`);

      const firstHalf  = await safeQueryFilter(filter, fromBlock, mid,     depth + 1);
      const secondHalf = await safeQueryFilter(filter, mid + 1,   toBlock, depth + 1);
      return [...firstHalf, ...secondHalf];
    }

    throw err;
  }
}

// ─── SyncMeta helpers — own checkpoint key, independent of the main
//     sync service's 'lastSyncedBlock' ────────────────────────────────
const SYNC_META_KEY = 'royaltyLastSyncedBlock';

async function getLastSyncedBlock(): Promise<number> {
  try {
    const meta = await prisma.syncMeta.findUnique({
      where: { key: SYNC_META_KEY },
    });
    if (meta) return parseInt(meta.value);
  } catch {}
  // falls back to the SAME deploy-block env var as the main sync
  // service — adjust to a ROYALTY_CONTRACT_DEPLOY_BLOCK env var if
  // this contract was deployed at a meaningfully different block than
  // the main FICON contract.
  const deployBlock = parseInt(process.env.ROYALTY_CONTRACT_DEPLOY_BLOCK ??  '0');
  console.log(`ℹ️  [RoyaltySync] No checkpoint — starting from block ${deployBlock}`);
  return deployBlock;
}

async function saveLastSyncedBlock(block: number): Promise<void> {
  await prisma.syncMeta.upsert({
    where:  { key: SYNC_META_KEY },
    update: { value: block.toString() },
    create: { key: SYNC_META_KEY, value: block.toString() },
  });
}

// ─── sync one block range ──────────────────────────────────────────────
async function syncRoyaltyClaims(fromBlock: number, toBlock: number): Promise<void> {
  const events = await safeQueryFilter(contract.filters.RoyaltyClaim(), fromBlock, toBlock);
  if (events.length === 0) return;

  let synced = 0;
  for (const e of events) {
    const args = e.args!;

    const userAddress = (args.user   as string).toLowerCase();
    const amount       = (args.amount as ethers.BigNumber);
    const poolNumber   = (args.package as ethers.BigNumber).toNumber();
    const timestamp    = (args.time  as ethers.BigNumber).toNumber();
    const txHash       = e.transactionHash.toLowerCase();

    const amountClaim = ethers.utils.formatUnits(amount, 18);

    try {
      const result = await royaltyIncomeService(userAddress, amountClaim, poolNumber, timestamp, txHash);
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [RoyaltySync] RoyaltyClaim failed ${userAddress} PKG${poolNumber}:`, err.message);
    }
  }

  console.log(`   RoyaltyClaim: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);
}

// ─── main run — single batched pass from checkpoint to latest block ──
let isSyncing = false;

export async function runRoyaltySync(): Promise<void> {
  if (isSyncing) {
    console.log('⏭️  [RoyaltySync] Already running — skipping tick');
    return;
  }
  isSyncing = true;

  try {
    const [lastSynced, currentBlock] = await Promise.all([
      getLastSyncedBlock(),
      provider.getBlockNumber(),
    ]);

    if (lastSynced >= currentBlock) {
      console.log(`✅ [RoyaltySync] Up to date at block ${currentBlock}`);
      return;
    }

    const gap     = currentBlock - lastSynced;
    const batches = Math.ceil(gap / BATCH_SIZE);
    console.log(`🔄 [RoyaltySync] ${gap} blocks behind → ${batches} batch(es)`);

    let from = lastSynced + 1;
    while (from <= currentBlock) {
      const to = Math.min(from + BATCH_SIZE - 1, currentBlock);
      console.log(`⏳ [RoyaltySync] Batch ${from}–${to}`);
      await syncRoyaltyClaims(from, to);
      await saveLastSyncedBlock(to);

      // small delay between batches — same rate-limit easing reasoning
      // as the main sync service
      await new Promise(r => setTimeout(r, 250));

      from = to + 1;
    }

    console.log(`✅ [RoyaltySync] Complete — DB at block ${currentBlock}`);

  } catch (err: any) {
    console.error('❌ [RoyaltySync] runRoyaltySync error:', err.message);
  } finally {
    isSyncing = false;
  }
}

// ─── scheduler — every 3 minutes, per requirement ──────────────────────
export function startRoyaltySyncScheduler(intervalMs = 3 * 60 * 1000): void {
  console.log(`🕐 [RoyaltySync] Scheduler started — every ${intervalMs / 60000} min`);
  runRoyaltySync().catch(err => console.error('❌ [RoyaltySync] startup error:', err.message));
  setInterval(() => {
    runRoyaltySync().catch(err => console.error('❌ [RoyaltySync] interval error:', err.message));
  }, intervalMs);
}