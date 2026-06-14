import { PrismaClient } from "@prisma/client"
const prisma = new PrismaClient()

export async function seedOwner(ownerAddress: string) {
  try {
    const normalizedAddress = ownerAddress.toLowerCase();

    // check owner is present or not
    const isOwnerExist = await prisma.user.findUnique({
      where: { userAddress: normalizedAddress },
    });

    if (isOwnerExist) {
      console.log("owner already exists");
      return;
    }

    // create owner user
    const owner = await prisma.user.create({
      data: {
        contractRegId: 1,
        userAddress: normalizedAddress,
        referalAddress: normalizedAddress, // owner refers to themselves
        isRegistered: true,
      },
    });

    console.log("✅ Owner created:", owner);

    // seed owner's GenerationTree node
    // owner has no upline — points to themselves as root
    const ownerTree = await prisma.generationTree.create({
      data: {
        uplineAddress: normalizedAddress,
        uplineUserId: owner.id,
        leftChildAddress: null,
        leftUserId: null,
        rightChildAddress: null,
        rightUserId: null,
      },
    });

    console.log("✅ Owner GenerationTree node created:", ownerTree);

  } catch (error) {
    console.log("something went wrong in seedOwner:", error);
  }
}

seedOwner("0xA30224CA6A6004369114F6A027e8A829EDcDa501");