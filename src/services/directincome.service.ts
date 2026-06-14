// src/services/directIncome.service.ts
import { prisma }         from '..';
import { getPackageInfo } from '../utils/getPackageInfo';
import { isUserExist }    from '../utils/userMethod';

export const directIncomeService = async (
  fromUserAddress: string,  // ← now actual buyer (user param in contract)
  toUserAddress:   string,  // ← referral who receives income
  amount:          string,
  packageNumber:   number,
  timestamp:       number,
  tranxHash:       string,
) => {
  try {
    const normalizedFrom   = fromUserAddress.toLowerCase();
    const normalizedTo     = toUserAddress.toLowerCase();
    const normalizedTxHash = tranxHash.toLowerCase();

    // ── 1. idempotency ────────────────────────────────────
    const existing = await prisma.directIncome.findUnique({
      where: {
        fromUserAddress_transactionHash_packageNumber: {
          fromUserAddress: normalizedFrom,
          transactionHash: normalizedTxHash,
          packageNumber,
        },
      },
    });
    if (existing) {
      console.log(`ℹ️  DirectIncome already recorded: ${normalizedTxHash} PKG${packageNumber}`);
      return existing;
    }

    // ── 2. recipient must exist ───────────────────────────
    const toUser = await isUserExist(normalizedTo);
    if (!toUser) {
      console.warn(`⚠️  DirectIncome: recipient ${normalizedTo} not in DB — skipping`);
      return null;
    }

    // ── 3. package info ───────────────────────────────────
    const packageInfo = getPackageInfo(packageNumber);
    if (!packageInfo) {
      console.warn(`⚠️  DirectIncome: unknown package ${packageNumber}`);
      return null;
    }

    // ── 4. create ─────────────────────────────────────────
    const saved = await prisma.directIncome.create({
      data: {
        fromUserAddress: normalizedFrom,
        amount,
        packageName:     packageInfo.name,
        packageNumber,
        timestamp:       String(timestamp),
        transactionHash: normalizedTxHash,
        userId:          toUser.id,
      },
    });

    console.log(`✅ DirectIncome: ${normalizedFrom} → ${normalizedTo} PKG${packageNumber} ${amount} USDT`);
    return saved;

  } catch (error: any) {
    if (error.code === 'P2002') {
      console.log(`ℹ️  DirectIncome already recorded (concurrent write)`);
      return null;
    }
    console.error('directIncomeService error:', error.message);
    throw error;
  }
};