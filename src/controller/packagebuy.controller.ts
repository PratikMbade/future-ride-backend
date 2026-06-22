// src/controllers/packageController.ts
import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { prisma } from '..';
import { getPackageInfo } from '../utils/getPackageInfo';
import contractAbi from '../contract/contract-abi.json';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── same provider/contract pattern as sync.service.ts and
//     onChainBalanceController.ts — read-only, no signer needed ─────────────
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_HTTP!);
const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS!,
  contractAbi,
  provider
);

// ─── fetch packageContractBuyId from the transaction's own logs ─────────────
// The frontend's POST fallback only sends transactionHash — it doesn't
// (and shouldn't have to) know the on-chain currentId, since that's an
// event-emitted value, not something computed client-side. To recover
// it here: fetch the transaction's receipt, find the PackageBuyEV log
// inside it, and decode that log's `currentId` argument — the exact
// same field event-listener.ts's real-time listener already extracts
// as `currentId.toNumber()`. This makes the POST fallback path produce
// IDENTICAL data to the event-listener path, not a degraded version of it.
async function getPackageContractBuyIdFromTx(
  transactionHash: string,
  expectedUser: string,
  expectedPackageNumber: number,
): Promise<number | null> {
  try {
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      console.warn(`⚠️  No receipt found for tx ${transactionHash} — chain may not have indexed it yet`);
      return null;
    }

    for (const log of receipt.logs) {
      // logs from OTHER contracts (e.g. the USDT approve/transfer in the
      // same tx) will fail to parse against our ABI — skip those rather
      // than letting one bad log abort the whole search
      let parsed: ethers.utils.LogDescription;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue;
      }

      if (parsed.name !== 'PackageBuyEV') continue;

      const eventUser          = (parsed.args.user as string).toLowerCase();
      const eventPackageNumber = (parsed.args.package as ethers.BigNumber).toNumber();

      // a single transaction could in theory contain multiple PackageBuyEV
      // logs (unlikely for this contract's flow, but defensive) — match on
      // user + package number to get the RIGHT one, not just the first one
      if (eventUser === expectedUser.toLowerCase() && eventPackageNumber === expectedPackageNumber) {
        const currentId = (parsed.args.currentId as ethers.BigNumber).toNumber();
        return currentId;
      }
    }

    console.warn(`⚠️  No matching PackageBuyEV log found in tx ${transactionHash} for ${expectedUser} PKG${expectedPackageNumber}`);
    return null;
  } catch (err: any) {
    console.warn(`⚠️  Failed to fetch/parse receipt for tx ${transactionHash}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
//  POST /api/packages/buy
//  Second-layer fallback if PackageBuyEV event missed
// ─────────────────────────────────────────────────────────
export const buyPackage = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    console.log('dbUser', dbUser);
    const { packageNumber, transactionHash } = req.body as {
      packageNumber: number;
      transactionHash: string;
    };

    // ── validate input ────────────────────────────────────
    if (!packageNumber || !transactionHash) {
      res.status(400).json({ error: 'packageNumber and transactionHash are required' });
      return;
    }

    if (typeof packageNumber !== 'number' || packageNumber < 1 || packageNumber > 10) {
      res.status(400).json({ error: 'packageNumber must be between 1 and 10' });
      return;
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
      res.status(400).json({ error: 'Invalid transactionHash format' });
      return;
    }

    // ── get package metadata ──────────────────────────────
    const packageInfo = getPackageInfo(packageNumber);
    if (!packageInfo) {
      res.status(400).json({ error: `Package ${packageNumber} not found` });
      return;
    }

    // ── check if user is registered ───────────────────────
    if (!dbUser.isRegistered) {
      res.status(403).json({ error: 'User is not registered on the contract' });
      return;
    }

    // ── enforce sequential buying ─────────────────────────
    // user must own package N-1 before buying package N
    if (packageNumber > 1) {
      const prevPackage = await prisma.package.findFirst({
        where: {
          userId: dbUser.id,
          packageNumber: packageNumber - 1,
        },
      });

      if (!prevPackage) {
        res.status(400).json({
          error: `Package ${packageNumber - 1} must be activated before buying package ${packageNumber}`,
        });
        return;
      }
    }

    // ── idempotency check — compound unique key ───────────
    // event listener may have already created this row
    const existing = await prisma.package.findUnique({
      where: {
        userId_tranxHash_packageNumber: {
          userId:        dbUser.id,
          tranxHash:     transactionHash,
          packageNumber,
        },
      },
    });

    if (existing) {
      res.status(200).json({
        success:        true,
        alreadyRecorded: true,
        message:        'Package already recorded',
        package:        existing,
      });
      return;
    }

    // ── recover packageContractBuyId from the tx's own event logs ──
    // This is what makes the POST fallback produce the SAME data shape
    // as the real-time event listener, instead of leaving this field
    // null whenever the fallback path is the one that ends up writing
    // the row.
    const packageContractBuyId = await getPackageContractBuyIdFromTx(
      transactionHash,
      dbUser.userAddress,
      packageNumber,
    );

    // ── create package record ─────────────────────────────
    const newPackage = await prisma.package.create({
      data: {
        packageNumber,
        packageContractBuyId,
        packageName:         packageInfo.name,
        packageAmount:       packageInfo.amount,
        packageBuyTranxHash: transactionHash,
        tranxHash:           transactionHash,
        userId:              dbUser.id,
      },
    });

    console.log(`✅ Package ${packageNumber} recorded for user ${dbUser.userAddress} via POST fallback (contractBuyId: ${packageContractBuyId ?? 'unresolved'})`);

    res.status(201).json({
      success: true,
      alreadyRecorded: false,
      message: `Package ${packageNumber} activated successfully`,
      package: newPackage,
    });

  } catch (error: any) {
    // handle Prisma unique constraint violation gracefully
    // (race condition: event listener and POST fired at same time)
    if (error.code === 'P2002') {
      res.status(200).json({
        success: true,
        alreadyRecorded: true,
        message: 'Package already recorded (concurrent write)',
      });
      return;
    }

    console.error('buyPackage error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
//  GET /api/packages
//  Get all packages for the authenticated user
// ─────────────────────────────────────────────────────────
export const getUserPackages = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const packages = await prisma.package.findMany({
      where: { userId: dbUser.id },
      orderBy: { packageNumber: 'asc' },
      select: {
        id:                  true,
        packageNumber:       true,
        packageName:         true,
        packageAmount:       true,
        packageBuyTranxHash: true,
        createdAt:           true,
      },
    });

    // highest package level
    const highestPackage = packages.length > 0
      ? Math.max(...packages.map((p) => p.packageNumber))
      : 0;

    // next package to buy
    const nextPackage = highestPackage < 10 ? highestPackage + 1 : null;

    res.status(200).json({
      success:        true,
      highestPackage,
      nextPackage,
      totalPackages:  packages.length,
      packages,
    });

  } catch (error: any) {
    console.error('getUserPackages error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};


export const getPackageHistory = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;

    const packages = await prisma.package.findMany({
      where:   { userId: dbUser.id },
      orderBy: { packageNumber: 'asc' },
      select: {
        id:                   true,
        packageNumber:        true,
        packageName:          true,
        packageAmount:        true,
        packageContractBuyId: true,
        createdAt:            true,
        tranxHash:            true,
      },
    });

    const rows = packages.map(p => ({
      id:                   p.id,
      packageContractBuyId: p.packageContractBuyId,
      packageNumber:        p.packageNumber,
      packageName:          p.packageName,
      packageAmount:        p.packageAmount,
      buyDate:              p.createdAt.toISOString(),
      transactionHash:      p.tranxHash,
    }));

    res.json({
      success: true,
      total:   rows.length,
      packages: rows,
    });

  } catch (error: any) {
    console.error('package-history error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};