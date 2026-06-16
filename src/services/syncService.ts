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

const BATCH_SIZE = 2000;

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
  const events = await contract.queryFilter(
    contract.filters.RegisterEV(), fromBlock, toBlock
  );
  if (events.length === 0) return;

  for (const e of events) {
    const args        = e.args!;
    const userAddress = (args.user    as string).toLowerCase();
    const referral    = (args.referal as string).toLowerCase();
    const regId       = (args.id      as ethers.BigNumber).toNumber();

    const existing = await prisma.user.findUnique({
      where:  { userAddress },
      select: { isRegistered: true },
    });
    if (existing?.isRegistered) continue;

    try {
      await registerUserService(userAddress, referral, regId);
      await new Promise(r => setTimeout(r, 300));
      console.log(`✅ [Sync] Registered: ${userAddress} (#${regId})`);
    } catch (err: any) {
      console.warn(`⚠️  [Sync] RegisterEV failed ${userAddress}:`, err.message);
    }
  }
  console.log(`   RegisterEV: ${events.length} processed (${fromBlock}–${toBlock})`);
}

// ─── Step 2: Package buys + upgrades ─────────────────────────────────────────
async function syncPackages(fromBlock: number, toBlock: number): Promise<void> {
  const [buyEvents, upgradeEvents] = await Promise.all([
    contract.queryFilter(contract.filters.PackageBuyEV(),     fromBlock, toBlock),
    contract.queryFilter(contract.filters.PackageUpgradeEV(), fromBlock, toBlock),
  ]);

  const allEvents = [...buyEvents, ...upgradeEvents]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex);

  if (allEvents.length === 0) return;

  let synced = 0;
  for (const e of allEvents) {
    const args          = e.args!;
    const userAddress   = (args.user    as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();

    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true },
    });

    if (!user) {
      console.warn(`⚠️  [Sync] Auto-creating missing user ${userAddress} for package event`);
      try {
        await registerUserService(userAddress, userAddress, 0);
      } catch {
        console.warn(`⚠️  [Sync] Could not auto-create user ${userAddress} — skipping package`);
        continue;
      }
    }

    try {
      const result = await packageBuyService(userAddress, packageNumber, txHash);
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] PackageEV failed ${userAddress} PKG${packageNumber}:`, err.message);
    }
  }

  if (allEvents.length > 0)
    console.log(`   Packages: ${synced}/${allEvents.length} synced (${fromBlock}–${toBlock})`);
}

// ─── Step 3: Income events ────────────────────────────────────────────────────
async function syncIncome(fromBlock: number, toBlock: number): Promise<void> {
  const [directEvents, genEvents, lapsEvents] = await Promise.all([
    contract.queryFilter(contract.filters.DirectPayEV(),     fromBlock, toBlock),
    contract.queryFilter(contract.filters.GenerationPayEV(), fromBlock, toBlock),
    contract.queryFilter(contract.filters.LapsPayEV(),       fromBlock, toBlock),
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
// Runs AFTER income — depends on User + Package existing.
//
// Updated event signature:
//   UpgradeHolding(
//     address indexed user,      ← genUpline — who accumulates holding
//     address fromUser,          ← buyer who triggered it (NOT indexed)
//     uint256 indexed package,
//     uint256 indexed amount,    ← actual holding amount in wei
//     uint256 time,              ← block.timestamp
//     uint256 lvlPay             ← tree level
//   )
async function syncUpgradeHolding(fromBlock: number, toBlock: number): Promise<void> {
  const events = await contract.queryFilter(
    contract.filters.UpgradeHolding(), fromBlock, toBlock
  );
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
// 1. Registrations → creates User records
// 2. Packages      → creates Package records  (needs User)
// 3. Income        → Direct / Gen / Laps      (needs User + Package)
// 4. UpgradeHolding                           (needs User + Package)
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
export function startSyncScheduler(intervalMs = 5 * 60 * 1000): void {
  console.log(`🕐 [Sync] Scheduler started — every ${intervalMs / 60000} min`);
  runSync().catch(err => console.error('❌ [Sync] startup error:', err.message));
  setInterval(() => {
    runSync().catch(err => console.error('❌ [Sync] interval error:', err.message));
  }, intervalMs);
}