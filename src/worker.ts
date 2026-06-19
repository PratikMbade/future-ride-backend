// src/worker.ts
import { prisma } from './lib/prisma'; // shared standalone module — see lib/prisma.ts

import {
  registrationEventListener,
  packageBuyEventListener,
  packageUpgradeEventListener,
  directIncomeEventListener,
  generationEventListener,
  lapsIncomeEventListener,
  upgradeHoldingEventListener,
} from './contract/event-listener';
import { startSyncScheduler } from './services/syncService';

async function main() {
  console.log('🔗 [Worker] Blockchain worker starting…');

  // connect Prisma
  await prisma.$connect();
  console.log('✅ [Worker] Prisma connected');

  // start all 6 event listeners
  registrationEventListener();
  packageBuyEventListener();
  packageUpgradeEventListener();
  directIncomeEventListener();
  generationEventListener();
  lapsIncomeEventListener();
  upgradeHoldingEventListener();
  // catch-up sync — every 5 minutes
  startSyncScheduler(5 * 60 * 1000);

  console.log('✅ [Worker] All listeners + sync scheduler running');
}

main().catch(err => {
  console.error('❌ [Worker] Fatal startup error:', err);
  process.exit(1);
});

// graceful shutdown
process.on('SIGINT',  () => { prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', () => { prisma.$disconnect(); process.exit(0); });