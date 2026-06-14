// src/services/generationIncome.service.ts
import { prisma }        from '..';
import { getPackageInfo } from '../utils/getPackageInfo';
import { isUserExist }   from '../utils/userMethod';

export const generationIncomeService = async (
  from:          string,   // contract address (address(this))
  toUserAddress: string,   // recipient — upline who earned
  amount:        string,
  packageNumber: number,
  level:         number,   // lvlpay — how many tree hops up
  timestamp:     number,
  tranxHash:     string,
  originalBuyer: string,   // the user who bought a package
) => {
  try {
    const normalizedTo     = toUserAddress.toLowerCase();
    const normalizedTxHash = tranxHash.toLowerCase();
    const normalizedBuyer  = originalBuyer.toLowerCase();

    // ── idempotency ────────────────────────────────────────
    // @@unique([originalbuyer,transactionHash, packageNumber]) in schema
    const existing = await prisma.generationIncome.findUnique({
      where: {
        fromUserAddress_transactionHash_packageNumber: {
         fromUserAddress:normalizedBuyer,
          transactionHash: normalizedTxHash,
          packageNumber,
        },
      },
    });
    if (existing) {
      console.log(`ℹ️  GenerationIncome already recorded: ${normalizedTxHash} PKG${packageNumber}`);
      return existing;
    }

    // ── recipient must exist in DB ─────────────────────────
    const toUser = await isUserExist(normalizedTo);
    if (!toUser) {
      // owner may not be in DB — create a minimal record and continue
      console.warn(`⚠️  GenerationIncome recipient ${toUserAddress} not in DB — skipping`);
      return null;
    }

    const packageInfo = getPackageInfo(packageNumber);

    const saved = await prisma.generationIncome.create({
      data: {
        fromUserAddress: normalizedBuyer, // original buyer (more useful than contract addr)
        packageNumber,
        packageName:     packageInfo?.name ?? `Package ${packageNumber}`,
        amount,
        timestamp:       String(timestamp),
        userId:          toUser.id,
        transactionHash: normalizedTxHash,
        level,                            // ← stored for dashboard display
      },
    });

    console.log(`✅ GenerationIncome: buyer ${normalizedBuyer} → earner ${normalizedTo} PKG${packageNumber} LVL${level} ${amount} USDT`);
    return saved;

  } catch (err: any) {
    if (err.code === 'P2002') {
      console.log(`ℹ️  GenerationIncome already recorded (concurrent write)`);
      return null;
    }
    console.error('generationIncomeService error:', err.message);
    throw err;
  }
};