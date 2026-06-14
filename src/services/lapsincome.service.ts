// src/services/lapsIncome.service.ts
import { prisma }        from '..';
import { getPackageInfo } from '../utils/getPackageInfo';
import { isUserExist }   from '../utils/userMethod';

export const lapsIncomeService = async (
  from:          string,   // contract address
  toUserAddress: string,   // who received the payment (eligible upline or owner)
  amount:        string,
  packageNumber: number,
  level:         number,   // lvlpay — tree level where laps occurred
  timestamp:     number,
  tranxHash:     string,
  lapsedAddress: string,   // lapAdd — address that missed/was skipped
) => {
  try {
    const normalizedTo     = toUserAddress.toLowerCase();
    const normalizedLapsed = lapsedAddress.toLowerCase();
    const normalizedTxHash = tranxHash.toLowerCase();

    // ── idempotency ────────────────────────────────────────
    // @@unique([transactionHash, packageNumber, fromUserAddress]) in schema
    const existing = await prisma.lapsIncome.findUnique({
      where: {
        transactionHash_packageNumber_fromUserAddress: {
          transactionHash: normalizedTxHash,
          packageNumber,
          fromUserAddress: normalizedLapsed,
        },
      },
    });
    if (existing) {
      console.log(`ℹ️  LapsIncome already recorded: ${normalizedTxHash} PKG${packageNumber}`);
      return existing;
    }

    // ── recipient ──────────────────────────────────────────
    const toUser = await isUserExist(normalizedTo);
    if (!toUser) {
      console.warn(`⚠️  LapsIncome recipient ${toUserAddress} not in DB — skipping`);
      return null;
    }

    const packageInfo = getPackageInfo(packageNumber);

    const saved = await prisma.lapsIncome.create({
      data: {
        fromUserAddress: normalizedLapsed, // who was lapsed (skipped)
        packageNumber,
        packageName:     packageInfo?.name ?? `Package ${packageNumber}`,
        amount,
        timestamp:       String(timestamp),
        userId:          toUser.id,        // who actually received the payment
        transactionHash: normalizedTxHash,
        level,                             // ← tree level where laps occurred
      },
    });

    console.log(`✅ LapsIncome: ${normalizedLapsed} lapsed → ${normalizedTo} PKG${packageNumber} LVL${level} ${amount} USDT`);
    return saved;

  } catch (err: any) {
    if (err.code === 'P2002') {
      console.log(`ℹ️  LapsIncome already recorded (concurrent write)`);
      return null;
    }
    console.error('lapsIncomeService error:', err.message);
    throw err;
  }
};