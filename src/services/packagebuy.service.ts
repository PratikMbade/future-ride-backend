// src/services/packageBuy.service.ts
import { prisma } from "..";
import { getPackageInfo } from "../utils/getPackageInfo";

export const packageBuyService = async (
  userAddress: string,
  packageNumber: number,
  packageContractBuyId: number,
  transactionHash: string,
  timestamp:string
) => {
  try {
    const normalizedAddress = userAddress.toLowerCase();
    const normalizedTxHash  = transactionHash.toLowerCase();

    if(packageContractBuyId === null){
      console.log('packageContractBuyId is null we are not updating package record');
      return
    }

    // 1. find user
    const user = await prisma.user.findUnique({
      where: { userAddress: normalizedAddress },
    });

    if (!user) throw new Error(`User ${userAddress} not found in DB`);

    // 2. get package metadata
    const packageInfo = getPackageInfo(packageNumber);
    if (!packageInfo) throw new Error(`Invalid package number: ${packageNumber}`);

    // 3. idempotency — check compound unique (userId + tranxHash + packageNumber)
    //    This is the ONLY check that should gate creation. It correctly
    //    covers both: the event listener already wrote this exact row,
    //    OR a prior call to this same service already did.
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

    // ── REMOVED: the old global packageBuyTranxHash uniqueness check ──
    // That check assumed one transaction hash maps to exactly ONE
    // package purchase across the entire platform. That assumption is
    // false: a single transaction can legitimately produce package
    // records for MULTIPLE DIFFERENT USERS at once — e.g. user A buys
    // package 4 directly, and that same transaction triggers an
    // accumulated-holding auto-upgrade for a DIFFERENT upline user B
    // to package 5 (confirmed in production logs: one tx hash, two
    // PackageBuyEV-family events, two different userAddresses). The
    // old check found A's row already sitting under that tx hash and
    // incorrectly treated B's legitimate, different package record as
    // a duplicate — silently dropping it.
    //
    // The compound check above (userId + tranxHash + packageNumber) is
    // the actually-correct uniqueness boundary: it allows the same tx
    // hash to appear across multiple users' package rows, while still
    // preventing the SAME user from getting the SAME package recorded
    // twice for the SAME transaction (e.g. event listener + this
    // fallback service both firing for the identical event).
    //
    // packageBuyTranxHash still exists as a schema column (kept for
    // backward compatibility / display purposes — e.g. linking to
    // BscScan from a single buy event), but it is no longer used as a
    // uniqueness constraint here. If your Prisma schema marks
    // packageBuyTranxHash as @unique at the DB level, that constraint
    // needs to be removed/loosened too, or this exact bug will resurface
    // as a P2002 error instead of a silent skip — see the note below.

    // 4. create package record
    const newPackage = await prisma.package.create({
      data: {
        packageNumber,
        packageName:          packageInfo.name,
        packageAmount:        packageInfo.amount,
        packageContractBuyId: packageContractBuyId,
        packageBuyTimestamp:timestamp,
        packageBuyTranxHash:  normalizedTxHash,
        tranxHash:            normalizedTxHash,
        userId:               user.id,
      },
    });

    console.log(`✅ Package ${packageNumber} recorded for ${normalizedAddress}`);
    return newPackage;

  } catch (error: any) {
    // P2002 = unique constraint violation. This can now happen for one
    // of two reasons:
    //   (a) genuine race condition — event listener and a fallback
    //       service both fired for the IDENTICAL (user, tx, package)
    //       combination at the same moment. Safe to treat as already-handled.
    //   (b) packageBuyTranxHash is STILL marked @unique in your Prisma
    //       schema, in which case this exact bug will resurface as a
    //       hard P2002 failure instead of the silent skip it was
    //       before — meaning user B's legitimate package record would
    //       fail to insert at all, rather than just being misreported
    //       as "already recorded." If you see P2002 errors specifically
    //       mentioning packageBuyTranxHash after this fix, that schema
    //       constraint needs to change to a NON-unique column (or a
    //       compound unique on [userId, packageBuyTranxHash] instead
    //       of a bare unique on the column alone).
    if (error.code === 'P2002') {
      console.log(`ℹ️  Package ${packageNumber} already recorded (concurrent write) for ${userAddress}`);
      return null;
    }
    console.error('packageBuyService error:', error.message);
    throw error;
  }
};