// src/services/upgradeHolding.service.ts
import { prisma } from '..';
import { ethers } from 'ethers';

export const upgradeHoldingService = async (
  userAddress:     string,   // genUpline — who gets the holding
  fromUserAddress: string,   // the buyer who triggered distribution
  packageNumber:   number,
  amountWei:       ethers.BigNumber,  // raw amount from event (in wei, 18 decimals)
  timestamp:       number,            // block.timestamp
  level:           number,            // lvlPay from event
  txHash:          string,
) => {
  try {
    const normalizedUser     = userAddress.toLowerCase();
    const normalizedFromUser = fromUserAddress.toLowerCase();
    const normalizedTxHash   = txHash.toLowerCase();

    // convert wei → human readable USDT string
    const amount = ethers.utils.formatUnits(amountWei, 18);

    // find the holding user in DB
    const user = await prisma.user.findUnique({
      where:  { userAddress: normalizedUser },
      select: { id: true },
    });

    if (!user) {
      console.warn(`⚠️  UpgradeHolding: user ${normalizedUser} not in DB — skipping`);
      return null;
    }

    // idempotent upsert
    const record = await prisma.upgradeHolding.upsert({
      where: {
        transactionHash_packageNumber_userId: {
          transactionHash: normalizedTxHash,
          packageNumber,
          userId: user.id,
        },
      },
      update: {}, // already stored — skip
      create: {
        userId:          user.id,
        userAddress:     normalizedUser,
        fromUserAddress: normalizedFromUser,
        packageNumber,
        amount,
        level,
        timestamp,
        transactionHash: normalizedTxHash,
      },
    });

    console.log(
      `✅ UpgradeHolding: ${normalizedUser} ← ${normalizedFromUser} PKG${packageNumber} LVL${level} +${amount} USDT`
    );
    return record;

  } catch (err: any) {
    console.error('❌ upgradeHoldingService error:', err.message);
    throw err;
  }
};