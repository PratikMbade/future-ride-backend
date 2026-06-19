// src/services/packageBuy.service.ts
import { prisma } from "..";
import { getPackageInfo } from "../utils/getPackageInfo";

export const packageBuyService = async (
  userAddress: string,
  packageNumber: number,
  packageContractBuyId:number,
  transactionHash: string,
) => {
  try {
    const normalizedAddress = userAddress.toLowerCase();
    console.log('normalizedAddress',normalizedAddress);
    console.log('userAddress',userAddress);
    const normalizedTxHash  = transactionHash.toLowerCase();

    // 1. find user
    const user = await prisma.user.findUnique({
      where: { userAddress: normalizedAddress },
    });

    if (!user) throw new Error(`User ${userAddress} not found in DB`);

    // 2. get package metadata
    const packageInfo = getPackageInfo(packageNumber);
    if (!packageInfo) throw new Error(`Invalid package number: ${packageNumber}`);

    // 3. idempotency — check compound unique
    //    covers both: event already wrote it OR prior call
    const existing = await prisma.package.findUnique({
      where: {
        userId_tranxHash_packageNumber: {
          userId:        user.id,
          tranxHash:     normalizedTxHash,
          packageNumber,
        },
      },
    });

    if (existing) {
      console.log(`ℹ️  Package ${packageNumber} already recorded for ${normalizedAddress}`);
      return existing; // idempotent — return existing, not an error
    }

    // 4. also check packageBuyTranxHash uniqueness
    //    (same tx can't be used for two different packages)
    const existingByTxHash = await prisma.package.findUnique({
      where: { packageBuyTranxHash: normalizedTxHash },
    });

    if (existingByTxHash) {
      console.log(`ℹ️  Transaction ${normalizedTxHash} already used for a package`);
      return existingByTxHash;
    }

    // 5. create package record
    const newPackage = await prisma.package.create({
      data: {
        packageNumber,
        packageName:         packageInfo.name,
        packageAmount:       packageInfo.amount,
        packageContractBuyId:packageContractBuyId,
        packageBuyTranxHash: normalizedTxHash,
        tranxHash:           normalizedTxHash,
        userId:              user.id,
      },
    });

    console.log(`✅ Package ${packageNumber} recorded for ${normalizedAddress}`);
    return newPackage;

  } catch (error: any) {
    // P2002 = race condition (event + POST fired simultaneously) — safe
    if (error.code === 'P2002') {
      console.log(`ℹ️  Package ${packageNumber} already recorded (concurrent write)`);
      return null;
    }
    console.error('packageBuyService error:', error.message);
    throw error;
  }
};