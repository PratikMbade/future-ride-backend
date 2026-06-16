// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { generateFiconId } from "../src/utils/ficonId";

const prisma = new PrismaClient();

export async function seedOwner(ownerAddress: string) {
  try {
    const normalizedAddress = ownerAddress.toLowerCase();

    const isOwnerExist = await prisma.user.findUnique({
      where:  { userAddress: normalizedAddress },
      select: { id: true, ficonId: true },
    });

    if (isOwnerExist) {
      console.log("✅ Owner already exists — ficonId:", isOwnerExist.ficonId);

      // backfill ficonId if it was seeded before this feature was added
      if (!isOwnerExist.ficonId) {
        const ficonId = generateFiconId(normalizedAddress);
        await prisma.user.update({
          where: { userAddress: normalizedAddress },
          data:  { ficonId },
        });
        console.log("✅ Backfilled ficonId:", ficonId);
      }
      return;
    }

    // generate deterministic FICON ID for the owner
    const ficonId = generateFiconId(normalizedAddress);
    console.log(`🔑 Owner FICON ID: ${ficonId}`);

    // create owner
    const owner = await prisma.user.create({
      data: {
        contractRegId:  1,
        userAddress:    normalizedAddress,
        referalAddress: normalizedAddress, // owner refers to themselves
        isRegistered:   true,
        name:           normalizedAddress, // required by better-auth
        ficonId,
      },
    });
    console.log("✅ Owner created:", owner.userAddress, "→", owner.ficonId);

    // seed owner's GenerationTree node
    const ownerTree = await prisma.generationTree.create({
      data: {
        uplineAddress:    normalizedAddress,
        uplineUserId:     owner.id,
        leftChildAddress:  null,
        leftUserId:        null,
        rightChildAddress: null,
        rightUserId:       null,
      },
    });
    console.log("✅ Owner GenerationTree node created:", ownerTree.id);

  } catch (error) {
    console.error("❌ seedOwner error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

seedOwner("0xA30224CA6A6004369114F6A027e8A829EDcDa501");