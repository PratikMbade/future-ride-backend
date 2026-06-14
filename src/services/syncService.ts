// src/services/sync.service.ts
// Polls the blockchain in batches and fills DB gaps when event listener was offline
import { ethers }                  from 'ethers';
import { prisma }                  from '..';
import { registerUserService }     from './registeruser.service';
import { generationTreeService }   from './generationtree.service';
import { packageBuyService }       from './packagebuy.service';
import { directIncomeService }     from './directincome.service';
import { generationIncomeService } from './generationincome.service';
import { lapsIncomeService }       from './lapsincome.service';
import contractAbi                 from '../contract/contract-abi.json';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── provider + contract (HTTP, not WSS — for queryFilter) ────────────────────
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractAbi,
  provider
);

// ─── constants ────────────────────────────────────────────────────────────────
const BATCH_SIZE = 2000; // blocks per RPC call — stays within Alchemy limits

// ─── SyncMeta helpers ─────────────────────────────────────────────────────────
async function getLastSyncedBlock(): Promise<number> {
  try {
    const meta = await prisma.syncMeta.findUnique({
      where: { key: 'lastSyncedBlock' },
    });
    if (meta) return parseInt(meta.value);
  } catch {
    // table might not exist yet on first run
  }
  // first run → start from contract deploy block
  const deployBlock = parseInt(process.env.CONTRACT_DEPLOY_BLOCK ?? '0');
  console.log(`ℹ️  No sync checkpoint found — starting from block ${deployBlock}`);
  return deployBlock;
}

async function saveLastSyncedBlock(block: number): Promise<void> {
  await prisma.syncMeta.upsert({
    where:  { key: 'lastSyncedBlock' },
    update: { value: block.toString() },
    create: { key: 'lastSyncedBlock', value: block.toString() },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC REGISTRATIONS
//  event RegisterEV(
//    address indexed user,
//    address indexed referal,
//    uint256 indexed time,
//    uint256 id
//  )
// ─────────────────────────────────────────────────────────────────────────────
async function syncRegistrations(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.RegisterEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args        = e.args!;
    const userAddress = (args.user    as string).toLowerCase();
    const referral    = (args.referal as string).toLowerCase();
    const regId       = (args.id      as ethers.BigNumber).toNumber();

    // skip if already registered in DB
    const existing = await prisma.user.findUnique({
      where: { userAddress },
      select: { isRegistered: true },
    });
    if (existing?.isRegistered) continue;

    try {
      await registerUserService(userAddress, referral, regId);
      // small delay to let contract state settle before reading InternalGenStr
      await new Promise(r => setTimeout(r, 500));
      await generationTreeService(userAddress);
      synced++;
      console.log(`✅ [Sync] Registered: ${userAddress} (#${regId})`);
    } catch (err: any) {
      console.warn(`⚠️  [Sync] RegisterEV failed for ${userAddress}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   RegisterEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC PACKAGE BUYS
//  event PackageBuyEV(
//    address indexed user,
//    uint256 indexed package,
//    uint256 time
//  )
// ─────────────────────────────────────────────────────────────────────────────
async function syncPackageBuys(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.PackageBuyEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args          = e.args!;
    const userAddress   = (args.user    as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();

    try {
      const result = await packageBuyService(userAddress, packageNumber, txHash);
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] PackageBuyEV failed ${userAddress} PKG${packageNumber}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   PackageBuyEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC PACKAGE UPGRADES  (auto-upgrade engine)
//  event PackageUpgradeEV(
//    address indexed user,
//    uint256 indexed package,
//    uint256 time
//  )
//  Same DB write as PackageBuyEV — packageBuyService is idempotent
// ─────────────────────────────────────────────────────────────────────────────
async function syncPackageUpgrades(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.PackageUpgradeEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args          = e.args!;
    const userAddress   = (args.user    as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();

    try {
      const result = await packageBuyService(userAddress, packageNumber, txHash);
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] PackageUpgradeEV failed ${userAddress} PKG${packageNumber}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   PackageUpgradeEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC DIRECT INCOME
//  event DirectPayEV(
//    address indexed from,
//    address indexed to,
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time
//  )
// ─────────────────────────────────────────────────────────────────────────────
async function syncDirectIncome(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.DirectPayEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args          = e.args!;
    const from          = (args.from   as string).toLowerCase();
    const to            = (args.to     as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time   as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();

    try {
      const result = await directIncomeService(from, to, amountUsdt, packageNumber, timestamp, txHash);
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] DirectPayEV failed ${from}→${to}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   DirectPayEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC GENERATION INCOME
//  event GenerationPayEV(
//    address indexed from,     ← contract address (address(this))
//    address indexed to,       ← recipient upline
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time,
//    uint256 lvlpay,           ← generation level (tree hops)
//    address user              ← original buyer who triggered distribution
//  )
// ─────────────────────────────────────────────────────────────────────────────
async function syncGenerationIncome(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.GenerationPayEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args          = e.args!;
    const from          = (args.from   as string).toLowerCase();
    const to            = (args.to     as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const level         = (args.lvlpay  as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time   as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();
    const originalBuyer = (args.user   as string).toLowerCase();

    try {
      const result = await generationIncomeService(
        from,
        to,
        amountUsdt,
        packageNumber,
        level,
        timestamp,
        txHash,
        originalBuyer,
      );
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] GenerationPayEV failed ${originalBuyer}→${to} PKG${packageNumber} LVL${level}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   GenerationPayEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC LAPS INCOME
//  event LapsPayEV(
//    address indexed from,     ← contract address (address(this))
//    address indexed to,       ← who actually received the payment
//    uint256 indexed amount,
//    uint256 package,
//    uint256 time,
//    uint256 lvlpay,           ← tree level where laps occurred
//    address lapAdd            ← address that was skipped/lapsed
//  )
// ─────────────────────────────────────────────────────────────────────────────
async function syncLapsIncome(fromBlock: number, toBlock: number): Promise<number> {
  const events = await contract.queryFilter(
    contract.filters.LapsPayEV(),
    fromBlock,
    toBlock
  );

  let synced = 0;

  for (const e of events) {
    const args          = e.args!;
    const from          = (args.from   as string).toLowerCase();
    const to            = (args.to     as string).toLowerCase();
    const packageNumber = (args.package as ethers.BigNumber).toNumber();
    const level         = (args.lvlpay  as ethers.BigNumber).toNumber();
    const amountUsdt    = ethers.utils.formatUnits(args.amount as ethers.BigNumber, 18);
    const timestamp     = (args.time   as ethers.BigNumber).toNumber();
    const txHash        = e.transactionHash.toLowerCase();
    const lapsedAddress = (args.lapAdd as string).toLowerCase();

    try {
      const result = await lapsIncomeService(
        from,
        to,
        amountUsdt,
        packageNumber,
        level,
        timestamp,
        txHash,
        lapsedAddress,
      );
      if (result) synced++;
    } catch (err: any) {
      console.warn(`⚠️  [Sync] LapsPayEV failed ${lapsedAddress}→${to} PKG${packageNumber} LVL${level}:`, err.message);
    }
  }

  if (events.length > 0)
    console.log(`   LapsPayEV: ${synced}/${events.length} synced (${fromBlock}–${toBlock})`);

  return synced;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROCESS ONE BATCH  — all event types in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function processBatch(fromBlock: number, toBlock: number): Promise<void> {
  console.log(`⏳ [Sync] Batch ${fromBlock}–${toBlock}`);

  // run all 6 event types in parallel for this block range
  const [reg, buy, upgrade, direct, generation, laps] = await Promise.all([
    syncRegistrations(fromBlock,   toBlock),
    syncPackageBuys(fromBlock,     toBlock),
    syncPackageUpgrades(fromBlock, toBlock),
    syncDirectIncome(fromBlock,    toBlock),
    syncGenerationIncome(fromBlock, toBlock),
    syncLapsIncome(fromBlock,      toBlock),
  ]);

  const total = reg + buy + upgrade + direct + generation + laps;
  if (total > 0) {
    console.log(`   ↳ batch total: ${total} records synced`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN SYNC RUNNER
// ─────────────────────────────────────────────────────────────────────────────
let isSyncing = false; // prevent overlapping runs

export async function runSync(): Promise<void> {
  if (isSyncing) {
    console.log('⏭️  [Sync] Already running — skipping this tick');
    return;
  }
  isSyncing = true;

  try {
    const [lastSynced, currentBlock] = await Promise.all([
      getLastSyncedBlock(),
      provider.getBlockNumber(),
    ]);

    if (lastSynced >= currentBlock) {
      console.log(`✅ [Sync] DB is in sync at block ${currentBlock}`);
      return;
    }

    const gap = currentBlock - lastSynced;
    const batches = Math.ceil(gap / BATCH_SIZE);
    console.log(`🔄 [Sync] ${gap} blocks behind (${lastSynced + 1}→${currentBlock}) — ${batches} batch(es)`);

    let from = lastSynced + 1;

    while (from <= currentBlock) {
      const to = Math.min(from + BATCH_SIZE - 1, currentBlock);

      await processBatch(from, to);

      // save progress after every batch so a crash resumes from here
      await saveLastSyncedBlock(to);

      from = to + 1;
    }

    console.log(`✅ [Sync] Complete — DB is now at block ${currentBlock}`);

  } catch (err: any) {
    console.error('❌ [Sync] runSync error:', err.message);
  } finally {
    isSyncing = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEDULER  — call runSync immediately then every N minutes
// ─────────────────────────────────────────────────────────────────────────────
export function startSyncScheduler(intervalMs = 5 * 60 * 1000): void {
  const mins = intervalMs / 60000;
  console.log(`🕐 [Sync] Scheduler started — every ${mins} minute(s)`);

  // run immediately on startup to catch any gaps since last shutdown
  runSync().catch(err => console.error('❌ [Sync] startup run error:', err.message));

  // then on a repeating interval
  setInterval(() => {
    runSync().catch(err => console.error('❌ [Sync] interval run error:', err.message));
  }, intervalMs);
}