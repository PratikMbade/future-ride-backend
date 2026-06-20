// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { getPackageInfo } from "../src/utils/getPackageInfo"; // ASSUMPTION: path — adjust to match your actual project structure

const prisma = new PrismaClient();

const TOTAL_PACKAGES = 12;

export async function seedOwner(ownerAddress: string) {
  try {
    const normalizedAddress = ownerAddress.toLowerCase();

    const isOwnerExist = await prisma.user.findUnique({
      where:  { userAddress: normalizedAddress },
      select: { id: true, userAddress: true },
    });

    let ownerId: string;

    if (isOwnerExist) {
      console.log("✅ Owner already exists — address:", isOwnerExist.userAddress);
      ownerId = isOwnerExist.id;
    } else {
      // create owner
      const owner = await prisma.user.create({
        data: {
          contractRegId:  1,
          userAddress:    normalizedAddress,
          referalAddress: normalizedAddress, // owner refers to themselves
          isRegistered:   true,
          name:           normalizedAddress, // required by better-auth
        },
      });
      console.log("✅ Owner created:", owner.userAddress);
      ownerId = owner.id;

      // seed owner's GenerationTree node — only needed on first creation
      const ownerTree = await prisma.generationTree.create({
        data: {
          uplineAddress:     normalizedAddress,
          uplineUserId:      owner.id,
          leftChildAddress:  null,
          leftUserId:        null,
          rightChildAddress: null,
          rightUserId:       null,
        },
      });
      console.log("✅ Owner GenerationTree node created:", ownerTree.id);
    }

    // ── seed all 12 packages for the owner ──────────────────────────
    // Synthetic placeholder hashes since there's no real on-chain
    // transaction backing these — clearly marked "seed" + package
    // number so they're unmistakably identifiable as non-real data if
    // anyone inspects the table later, and distinct per package so
    // they don't collide with the @unique constraint on
    // packageBuyTranxHash or the compound unique on
    // [userId, tranxHash, packageNumber].
    for (let packageNumber = 1; packageNumber <= TOTAL_PACKAGES; packageNumber++) {
      const packageInfo = getPackageInfo(packageNumber);
      if (!packageInfo) {
        console.warn(`⚠️  No package info found for package ${packageNumber} — skipping`);
        continue;
      }

      const syntheticTxHash = `0xseed${String(packageNumber).padStart(2, '0')}${normalizedAddress.slice(2)}`;

      const existingPackage = await prisma.package.findUnique({
        where: {
          userId_tranxHash_packageNumber: {
            userId:        ownerId,
            tranxHash:     syntheticTxHash,
            packageNumber,
          },
        },
      });

      if (existingPackage) {
        console.log(`ℹ️  Package ${packageNumber} already seeded for owner — skipping`);
        continue;
      }

      await prisma.package.create({
        data: {
          packageNumber,
          packageName:         packageInfo.name,
          packageAmount:       packageInfo.amount,
          packageBuyTranxHash: syntheticTxHash,
          tranxHash:           syntheticTxHash,
          userId:              ownerId,
        },
      });
      console.log(`✅ Package ${packageNumber} (${packageInfo.name}) seeded for owner`);
    }

    console.log(`✅ All ${TOTAL_PACKAGES} packages seeded for owner`);

  } catch (error) {
    console.error("❌ seedOwner error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

const ownerAddress = process.env.OWNER_ADDRESS || "0x0b0068c773d126f93Bba4862e3D50731E3e753F3"
seedOwner(ownerAddress);