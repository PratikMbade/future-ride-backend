// src/controllers/packageController.ts
import { Request, Response } from 'express';
import { prisma } from '..';
import { getPackageInfo } from '../utils/getPackageInfo';

// ─────────────────────────────────────────────────────────
//  POST /api/packages/buy
//  Second-layer fallback if PackageBuyEV event missed
// ─────────────────────────────────────────────────────────
export const buyPackage = async (req: Request, res: Response) => {
  try {
    const dbUser = (req as any).dbUser;
    console.log('dbUser',dbUser);
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

   
    // ── create package record ─────────────────────────────
  const newPackage = await prisma.package.create({
  data: {
    packageNumber,
    packageName:         packageInfo.name,
    packageAmount:       packageInfo.amount,
    packageBuyTranxHash: transactionHash,
    tranxHash:           transactionHash,
    userId:              dbUser.id,
  },
});

    console.log(`✅ Package ${packageNumber} recorded for user ${dbUser.userAddress} via POST fallback`);

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
 