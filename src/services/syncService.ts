// src/services/sync.service.ts
import { ethers }                  from 'ethers';
import { prisma }                  from '..';
import { registerUserService }     from './registeruser.service';
import { packageBuyService }       from './packagebuy.service';
import { directIncomeService }     from './directincome.service';
import { generationIncomeService } from './generationincome.service';
import { lapsIncomeService }       from './lapsincome.service';
import { upgradeHoldingService }   from './upgradeHolding.service';
import contractAbi                 from '../contract/contract-abi.json';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);
const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractAbi,
  provider
);

// ↓ reduced from 2000 — Alchemy's BNB mainnet tier rejects wide eth_getLogs
// ranges even well under 2000 blocks, especially with topic filters applied.
const BATCH_SIZE = 500;

// ─── safe queryFilter wrapper — auto-retries with halved range on
//     Alchemy's "invalid block range params" (-32000) error ──────────────────
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
      console.warn(`⚠️  [Sync] Range rejected (${fromBlock}-${toBlock}, depth ${depth}) — splitting at ${mid}`);

      const firstHalf  = await safeQueryFilter(filter, fromBlock, mid,     depth + 1);
      const secondHalf = await safeQueryFilter(filter, mid + 1,   toBlock, depth + 1);
      return [...firstHalf, ...secondHalf];
    }

    // not a range error, or we've already split 8 times — give up and rethrow
    throw err;
  }
}

// ─── SyncMeta helpers ─────────────────────────────────────────────────────────
async function getLastSyncedBlock(): Promise<number> {
  try {
    const meta = await prisma.syncMeta.findUnique({
      where: { key: 'lastSyncedBlock' },
    });
    if (meta) return parseInt(meta.value);
  } catch {}
  const deployBlock = parseInt(process.env.CONTRACT_DEPLOY_BLOCK ?? '0');
  console.log(`ℹ️  No sync checkpoint — starting from block ${deployBlock}`);
  return deployBlock;
}

async function saveLastSyncedBlock(block: number): Promise<void> {
  await prisma.syncMeta.upsert({
    where:  { key: 'lastSyncedBlock' },
    update: { value: block.toString() },
    create: { key: 'lastSyncedBlock', value: block.toString() },
  });
}

// ─── Step 1: Registrations ────────────────────────────────────────────────────
async function syncRegistrations(fromBlock: number, toBlock: number): Promise<void> {
  const events = await safeQueryFilter(contract.filters.RegisterEV(), fromBlock, toBlock);
  if (events.length === 0) return;

  for (const e of events) {
    const args        = e.args!;
    const userAddress = (args.user    as string).toLowerCase();
    const referral    = (args.referal as string).toLowerCase();
    const regId       = (args.id      as ethers.BigNumber).toNumber();
    const timestamp = (args.time as ethers.BigNumber).toNumber()
    const existing = await prisma.user.findUnique({
      where:  { userAddress },
      select: { isRegistered: true },
    });
    if (existing?.isRegistered) continue;

    try {
      await registerUserService(userAddress, referral, regId,String(timestamp));
      await new Promise(r => setTimeout(r, 300));
      console.log(`✅ [Sync] Registered: ${userAddress} (#${regId})`);
    } catch (err: any) {
      console.warn(`⚠️  [Sync] RegisterEV failed ${userAddress}:`, err.message);
    }
  }
  console.log(`   RegisterEV: ${events.length} processed (${fromBlock}–${toBlock})`);
}

// ─── Step 2: Package buys + upgrades ─────────────────────────────────────────
// Buy and upgrade events need DIFFERENT services:
//   - PackageBuyEV     → packageBuyService (first-time purchase, no holding involved)
//   - PackageUpgradeEV → packageBuyService also (idempotent — same service
//                         event-listener.ts uses for both, since the DB
//                         action is identical; only the contract code path
//                         that emitted the event differs)
//
// Each event type carries different args from the contract, so they're
// fetched and looped independently rather than merged into one generic loop.
async function syncPackages(fromBlock: number, toBlock: number): Promise<void> {
  const [buyEvents, upgradeEvents] = await Promise.all([
    safeQueryFilter(contract.filters.PackageBuyEV(),     fromBlock, toBlock),
    safeQueryFilter(contract.filters.PackageUpgradeEV(), fromBlock, toBlock),
  ]);


  if (buyEvents.length === 0 && upgradeEvents.length === 0) return;

  // ── PackageBuyEV — first-time purchases ──────────────────────────────────
  let buySynced = 0;
  for (const e of buyEvents) {
    const args          = e.args!;
    const userAddress   = (args.user    as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const packageContractBuyId = (args.currentId as ethers.BigNumber).toNumber();
    const timestamp = (args.time as ethers.BigNumber).toNumber()
    const txHash         = e.transactionHash.toLowerCase();

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true },
    });

    if (!user) {
      console.warn(`⚠️  [Sync] Auto-creating missing user ${userAddress} for package buy event`);
      try {
        const userDetails = await contract.RegisterUserDetails(userAddress);
        const contractRegId = (userDetails.regId as ethers.BigNumber).toNumber();
        await registerUserService(userAddress, userAddress, contractRegId, String(timestamp));
      } catch {
        console.warn(`⚠️  [Sync] Could not auto-create user ${userAddress} — skipping package`);
        continue;
      }
    }

    try {
      const result = await packageBuyService(userAddress, packageNumber, packageContractBuyId, txHash,String(timestamp));
      if (result) buySynced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] PackageBuyEV failed ${userAddress} PKG${packageNumber}:`, err.message);
    }
  }

  // ── PackageUpgradeEV — funded by accumulated holding ─────────────────────
  // BUG FIXED: this loop previously fetched packageContractBuyId-less
  // args (it read `eventTimestamp` instead, which packageBuyService
  // doesn't even take), checked whether the user existed, even had
  // auto-creation logic for a missing user — but never actually called
  // packageBuyService or any other service to record the upgrade. The
  // loop body ended right after the existence check, so upgradeSynced
  // stayed at 0 and every PackageUpgradeEV event was silently dropped:
  // no log line, no DB write, nothing. Confirmed in production — a
  // registration transaction's RegisterEV, PackageBuyEV (the auto-buy
  // of package 1), DirectPayEV, and GenerationPayEV all processed and
  // logged correctly, while a PackageUpgradeEV emitted in that SAME
  // transaction (an upline's accumulated-holding auto-upgrade,
  // triggered as a side effect of the new registration) vanished
  // entirely with zero trace.
  let upgradeSynced = 0;
  for (const e of upgradeEvents) {
    const args                 = e.args!;
    const userAddress          = (args.user as string).toLowerCase();
    const packageNumber        = (args.package as ethers.BigNumber).toNumber();
    const packageContractBuyId = (args.currentId as ethers.BigNumber).toNumber();
    const timestamp = (args.time as ethers.BigNumber).toNumber()
    const txHash                = e.transactionHash.toLowerCase();

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true },
    });

    if (!user) {
      console.warn(`⚠️  [Sync] Auto-creating missing user ${userAddress} for package upgrade event`);
      try {
        await registerUserService(userAddress, userAddress, 0,String(timestamp));
      } catch {
        console.warn(`⚠️  [Sync] Could not auto-create user ${userAddress} — skipping upgrade`);
        continue;
      }
    }

    // same service as PackageBuyEV — packageBuyService is idempotent,
    // matching event-listener.ts's own PackageUpgradeEV handling. Its
    // compound-unique check (userId + tranxHash + packageNumber)
    // correctly allows this row to coexist with a DIFFERENT user's
    // package row sharing the same tx hash, per the
    // packageBuyTranxHash uniqueness fix made earlier.
    try {
      const result = await packageBuyService(userAddress, packageNumber, packageContractBuyId, txHash,String(timestamp));
      if (result) upgradeSynced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] PackageUpgradeEV failed ${userAddress} PKG${packageNumber}:`, err.message);
    }
  }

  const totalEvents = buyEvents.length + upgradeEvents.length;
  if (totalEvents > 0)
    console.log(`   Packages: ${buySynced}/${buyEvents.length} bought, ${upgradeSynced}/${upgradeEvents.length} upgraded (${fromBlock}–${toBlock})`);
}

// ─── Step 3: Income events ────────────────────────────────────────────────────
async function syncIncome(fromBlock: number, toBlock: number): Promise<void> {
  const [directEvents, genEvents, lapsEvents] = await Promise.all([
    safeQueryFilter(contract.filters.DirectPayEV(),     fromBlock, toBlock),
    safeQueryFilter(contract.filters.GenerationPayEV(), fromBlock, toBlock),
    safeQueryFilter(contract.filters.LapsPayEV(),       fromBlock, toBlock),
  ]);

  // ── direct income ──────────────────────────────────────────────────────────
  let directSynced = 0;
  for (const e of directEvents) {
    const args          = e.args!;
    const from          = (args.from    as string).toLowerCase();
    const to            = (args.to      as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time    as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();
    try {
      const r = await directIncomeService(from, to, amountUsdt, packageNumber, timestamp, txHash);
      if (r) directSynced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] DirectPayEV failed:`, err.message);
    }
  }

  // ── generation income ──────────────────────────────────────────────────────
  let genSynced = 0;
  for (const e of genEvents) {
    const args          = e.args!;
    const from          = (args.from    as string).toLowerCase();
    const to            = (args.to      as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const level         = (args.lvlpay  as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time    as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();
    const originalBuyer = (args.user    as string).toLowerCase();
    try {
      const r = await generationIncomeService(from, to, amountUsdt, packageNumber, level, timestamp, txHash, originalBuyer);
      if (r) genSynced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] GenerationPayEV failed:`, err.message);
    }
  }

  // ── laps income ───────────────────────────────────────────────────────────
  let lapsSynced = 0;
  for (const e of lapsEvents) {
    const args          = e.args!;
    const from          = (args.from    as string).toLowerCase();
    const to            = (args.to      as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const level         = (args.lvlpay  as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time    as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();
    const lapsedAddress = (args.lapAdd  as string).toLowerCase();
    try {
      const r = await lapsIncomeService(from, to, amountUsdt, packageNumber, level, timestamp, txHash, lapsedAddress);
      if (r) lapsSynced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] LapsPayEV failed:`, err.message);
    }
  }

  const total       = directSynced + genSynced + lapsSynced;
  const totalEvents = directEvents.length + genEvents.length + lapsEvents.length;
  if (totalEvents > 0)
    console.log(`   Income: ${total}/${totalEvents} synced (direct:${directSynced} gen:${genSynced} laps:${lapsSynced})`);
}

// ─── Step 4: UpgradeHolding events ───────────────────────────────────────────
async function syncUpgradeHolding(fromBlock: number, toBlock: number): Promise<void> {
  const events = await safeQueryFilter(contract.filters.UpgradeHolding(), fromBlock, toBlock);
  if (events.length === 0) return;

  let synced = 0;
  for (const e of events) {
    const args = e.args!;

    const userAddress     = (args.user     as string).toLowerCase();
    const fromUserAddress = (args.fromUser as string).toLowerCase();
    const packageNumber   = (args.package  as ethers.BigNumber).toNumber();
    const amountWei       = (args.amount   as ethers.BigNumber);
    const timestamp       = (args.time     as ethers.BigNumber).toNumber();
    const level           = (args.lvlPay   as ethers.BigNumber).toNumber();
    const txHash          = e.transactionHash.toLowerCase();

    try {
      const r = await upgradeHoldingService(
        userAddress,
        fromUserAddress,
        packageNumber,
        amountWei,
        timestamp,
        level,
        txHash,
      );
      if (r) synced++;
    } catch (err: any) {
      console.warn(
        `⚠️  [Sync] UpgradeHolding failed ${userAddress} PKG${packageNumber}:`,
        err.message
      );
    }
  }

  console.log(`   UpgradeHolding: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);
}

// ─── Process one batch in strict dependency order ─────────────────────────────
async function processBatch(fromBlock: number, toBlock: number): Promise<void> {
  console.log(`⏳ [Sync] Batch ${fromBlock}–${toBlock}`);
  await syncRegistrations(fromBlock, toBlock);    // step 1
  await syncPackages(fromBlock, toBlock);          // step 2
  await syncIncome(fromBlock, toBlock);            // step 3
  await syncUpgradeHolding(fromBlock, toBlock);    // step 4
}

// ─── Main sync runner ─────────────────────────────────────────────────────────
let isSyncing = false;

export async function runSync(): Promise<void> {
  if (isSyncing) {
    console.log('⏭️  [Sync] Already running — skipping tick');
    return;
  }
  isSyncing = true;

  try {
    const [lastSynced, currentBlock] = await Promise.all([
      getLastSyncedBlock(),
      provider.getBlockNumber(),
    ]);

    if (lastSynced >= currentBlock) {
      console.log(`✅ [Sync] Up to date at block ${currentBlock}`);
      return;
    }

    const gap     = currentBlock - lastSynced;
    const batches = Math.ceil(gap / BATCH_SIZE);
    console.log(`🔄 [Sync] ${gap} blocks behind → ${batches} batch(es)`);

    let from = lastSynced + 1;
    while (from <= currentBlock) {
      const to = Math.min(from + BATCH_SIZE - 1, currentBlock);
      await processBatch(from, to);
      await saveLastSyncedBlock(to);

      // small delay between batches — eases rolling rate-limit pressure on
      // Alchemy, separate from the per-call range-splitting retry above
      await new Promise(r => setTimeout(r, 250));

      from = to + 1;
    }

    console.log(`✅ [Sync] Complete — DB at block ${currentBlock}`);

  } catch (err: any) {
    console.error('❌ [Sync] runSync error:', err.message);
  } finally {
    isSyncing = false;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
export function startSyncScheduler(intervalMs = 2 * 60 * 1000): void {
  console.log(`🕐 [Sync] Scheduler started — every ${intervalMs / 60000} min`);
  runSync().catch(err => console.error('❌ [Sync] startup error:', err.message));
  setInterval(() => {
    runSync().catch(err => console.error('❌ [Sync] interval error:', err.message));
  }, intervalMs);
}