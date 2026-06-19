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

    // ── lost income — the other side of the same event ──────────────────
    // The lapsed address missed out on this income; record it from their
    // perspective too, so their dashboard can show "you lost X USDT here."
    // Only record this if the lapsed address actually has a User row —
    // if it doesn't exist in our DB yet, there's no one to attribute the
    // loss to, so we skip silently (same pattern as the recipient check above).
    try {
      const lapsedUser = await isUserExist(normalizedLapsed);

      if (!lapsedUser) {
        console.warn(`⚠️  LostIncome: lapsed address ${normalizedLapsed} not in DB — skipping lost-income record`);
      } else {
        const existingLost = await prisma.lostIncome.findUnique({
          where: {
            transactionHash_packageNumber_lapsedAddress: {
              transactionHash: normalizedTxHash,
              packageNumber,
              lapsedAddress: normalizedLapsed,
            },
          },
        });

        if (existingLost) {
          console.log(`ℹ️  LostIncome already recorded: ${normalizedTxHash} PKG${packageNumber}`);
        } else {
          await prisma.lostIncome.create({
            data: {
              userId:              lapsedUser.id,
              lapsedAddress:       normalizedLapsed,
              redirectedToAddress: normalizedTo,
              packageNumber,
              packageName:         packageInfo?.name ?? `Package ${packageNumber}`,
              amount,             // same amount — what they would have received
              level,
              timestamp:           String(timestamp),
              transactionHash:     normalizedTxHash,
            },
          });

          console.log(`📉 LostIncome: ${normalizedLapsed} missed PKG${packageNumber} LVL${level} ${amount} USDT (went to ${normalizedTo})`);
        }
      }
    } catch (lostErr: any) {
      // a failure here should NOT roll back or block the LapsIncome record
      // that already succeeded above — log and move on
      if (lostErr.code === 'P2002') {
        console.log(`ℹ️  LostIncome already recorded (concurrent write)`);
      } else {
        console.error('LostIncome creation error:', lostErr.message);
      }
    }

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