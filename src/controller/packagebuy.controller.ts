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

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

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

    if (!TX_HASH_RE.test(transactionHash)) {
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
    // This is the ONLY real verification this endpoint has that the
    // person genuinely bought this package on-chain, in this
    // transaction. getPackageContractBuyIdFromTx returns null when no
    // matching PackageBuyEV log (for this exact user + package number)
    // exists in the given transaction — which means EITHER the
    // transaction hasn't been indexed yet, OR (critically) the
    // transaction has NOTHING TO DO with buying this package at all.
    const packageContractBuyId = await getPackageContractBuyIdFromTx(
      transactionHash,
      dbUser.userAddress,
      packageNumber,
    );

    if (packageContractBuyId === null) {
      console.warn(
        `🚨 [buyPackage] REJECTED — no matching PackageBuyEV found for ${dbUser.userAddress} PKG${packageNumber} in tx ${transactionHash}. ` +
        `This could mean the tx isn't indexed yet, OR this tx has nothing to do with this package purchase.`
      );
      res.status(400).json({
        error: 'Could not verify this package purchase on-chain. The transaction may not be indexed yet — please try again in a moment, or confirm the transaction hash is correct.',
      });
      return;
    }

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

    console.log(`✅ Package ${packageNumber} recorded for user ${dbUser.userAddress} via POST fallback (contractBuyId: ${packageContractBuyId})`);

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

// ─────────────────────────────────────────────────────────
//  GET /api/packages/lookup/:address
//  Admin/on-behalf-of lookup — resolves ANY wallet address to its
//  registration + package status, independent of the caller's own
//  session. Used by the "register/buy for other user" admin tool to
//  validate a target address before allowing a package purchase for
//  them (e.g. blocking package-2 purchases for a user who was never
//  registered, since they'd own zero packages).
// ─────────────────────────────────────────────────────────
export const lookupUserPackage = async (req: Request, res: Response) => {
  try {
    const address = (req.params.address as string || '').toLowerCase();

    if (!ADDRESS_RE.test(address)) {
      res.status(400).json({ error: 'Invalid address format' });
      return;
    }

    const user = await prisma.user.findUnique({
      where:  { userAddress: address },
      select: {
        userAddress:  true,
        isRegistered: true,
        futureRideId: true,
        packages:     { select: { packageNumber: true } },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found — this address has not registered yet' });
      return;
    }

    const highestPackage = user.packages.length > 0
      ? Math.max(...user.packages.map((p) => p.packageNumber))
      : 0;

    res.json({
      userAddress:   user.userAddress,
      isRegistered:  user.isRegistered,
      futureRideId:  user.futureRideId,
      highestPackage,
      nextPackage:   highestPackage < 12 ? highestPackage + 1 : null,
    });

  } catch (error: any) {
    console.error('lookupUserPackage error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
//  POST /api/packages/buy-for
//  On-behalf-of fallback — records a package purchase where the
//  CONNECTED/PAYING wallet (the admin operating the tool) is not the
//  same as the wallet that the package belongs to on-chain. Mirrors
//  buyPackage's verification exactly, just keyed by an explicit
//  userAddress in the body instead of the authenticated dbUser.
// ─────────────────────────────────────────────────────────
export const buyPackageForUser = async (req: Request, res: Response) => {
  try {
    const { userAddress, packageNumber, transactionHash } = req.body as {
      userAddress: string;
      packageNumber: number;
      transactionHash: string;
    };

    if (!userAddress || !packageNumber || !transactionHash) {
      res.status(400).json({ error: 'userAddress, packageNumber and transactionHash are required' });
      return;
    }

    if (!ADDRESS_RE.test(userAddress)) {
      res.status(400).json({ error: 'Invalid userAddress format' });
      return;
    }

    if (typeof packageNumber !== 'number' || packageNumber < 2 || packageNumber > 12) {
      res.status(400).json({ error: 'packageNumber must be between 2 and 12 for the on-behalf-of flow' });
      return;
    }

    if (!TX_HASH_RE.test(transactionHash)) {
      res.status(400).json({ error: 'Invalid transactionHash format' });
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where:   { userAddress: userAddress.toLowerCase() },
      include: { packages: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'Target user not found — they must register first' });
      return;
    }

    if (!targetUser.isRegistered) {
      res.status(403).json({ error: 'Target user is not registered on the contract' });
      return;
    }

    const highestOwned = targetUser.packages.length > 0
      ? Math.max(...targetUser.packages.map((p) => p.packageNumber))
      : 0;

    // sequential enforcement against the TARGET's own package history,
    // not the caller's — the caller is just paying, not the owner
    if (packageNumber !== highestOwned + 1) {
      res.status(400).json({
        error: `Target user must buy packages sequentially. They currently own up to package ${highestOwned}; the next purchase must be package ${highestOwned + 1}.`,
      });
      return;
    }

    const packageInfo = getPackageInfo(packageNumber);
    if (!packageInfo) {
      res.status(400).json({ error: `Package ${packageNumber} not found` });
      return;
    }

    const existing = await prisma.package.findUnique({
      where: {
        userId_tranxHash_packageNumber: {
          userId:        targetUser.id,
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

    // verify the tx's PackageBuyEV log actually names the TARGET user —
    // not the admin/caller — for this exact package number
    const packageContractBuyId = await getPackageContractBuyIdFromTx(
      transactionHash,
      targetUser.userAddress,
      packageNumber,
    );

    if (packageContractBuyId === null) {
      res.status(400).json({
        error: 'Could not verify this package purchase on-chain for the target user. The transaction may not be indexed yet, or it does not correspond to this purchase.',
      });
      return;
    }

    const newPackage = await prisma.package.create({
      data: {
        packageNumber,
        packageContractBuyId,
        packageName:         packageInfo.name,
        packageAmount:       packageInfo.amount,
        packageBuyTranxHash: transactionHash,
        tranxHash:           transactionHash,
        userId:              targetUser.id,
      },
    });

    console.log(`✅ Package ${packageNumber} recorded for ${targetUser.userAddress} via admin buy-for (contractBuyId: ${packageContractBuyId})`);

    res.status(201).json({
      success:         true,
      alreadyRecorded: false,
      message:         `Package ${packageNumber} activated for ${targetUser.userAddress}`,
      package:         newPackage,
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(200).json({
        success:         true,
        alreadyRecorded: true,
        message:         'Package already recorded (concurrent write)',
      });
      return;
    }

    console.error('buyPackageForUser error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};