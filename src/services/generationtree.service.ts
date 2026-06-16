// src/services/generationtree.service.ts
import { ethers } from "ethers";
import { prisma } from "..";
import { contract } from "../contract";

export const generationTreeService = async (userAddress: string) => {
  try {
    const normalizedAddress = userAddress.toLowerCase();

    // 1. check user exists in DB
    const user = await prisma.user.findUnique({
      where: { userAddress: normalizedAddress },
    });
    if (!user) throw new Error(`User ${userAddress} not found in DB`);

    // 2. read InternalGenStr from contract for this user
    const genStr        = await contract.InternalGenStr(userAddress);
    const uplineAddress = genStr.upline as string;

    if (!uplineAddress || uplineAddress === ethers.constants.AddressZero) {
      console.log(`ℹ️  ${userAddress} has no upline (root user)`);
      return;
    }

    const normalizedUpline = uplineAddress.toLowerCase();

    // 3. find upline user in DB
    const uplineUser = await prisma.user.findUnique({
      where: { userAddress: normalizedUpline },
    });
    if (!uplineUser) throw new Error(`Upline ${uplineAddress} not found in DB`);

    // 4. read upline's InternalGenStr to determine left/right position
    const uplineGenStr   = await contract.InternalGenStr(uplineAddress);
    const leftAddress    = (uplineGenStr.left   as string).toLowerCase();
    const rightAddress   = (uplineGenStr.right  as string).toLowerCase();
    const grandParentAddr = (uplineGenStr.upline as string).toLowerCase();

    const isLeft  = leftAddress  === normalizedAddress;
    const isRight = rightAddress === normalizedAddress;

    if (!isLeft && !isRight) {
      throw new Error(
        `${userAddress} is neither left nor right child of ${uplineAddress}`
      );
    }

    // 5. update upline's GenerationTree row — set this user as left or right child
    //    Use upsert here (for the UPLINE's row) — this is safe because
    //    the upline row was already created when the upline registered,
    //    so it will almost always be an update, never a race on create.
    await prisma.generationTree.upsert({
      where:  { uplineUserId: uplineUser.id },
      update: {
        ...(isLeft  && { leftChildAddress:  normalizedAddress, leftUserId:  user.id }),
        ...(isRight && { rightChildAddress: normalizedAddress, rightUserId: user.id }),
      },
      create: {
        uplineAddress:     grandParentAddr,
        uplineUserId:      uplineUser.id,
        leftChildAddress:  isLeft  ? normalizedAddress : null,
        leftUserId:        isLeft  ? user.id           : null,
        rightChildAddress: isRight ? normalizedAddress : null,
        rightUserId:       isRight ? user.id           : null,
      },
    });

    console.log(
      `✅ Upline tree updated: ${normalizedUpline} → ${isLeft ? 'LEFT' : 'RIGHT'}: ${normalizedAddress}`
    );

    // 6. create THIS user's own GenerationTree node
    //
    //    WHY NOT upsert here?
    //    upsert has a race condition — if syncRegistrations and the event listener
    //    both call generationTreeService for the same user simultaneously,
    //    both see "no row exists", both try to create, one wins, one gets P2002.
    //
    //    findUnique + create lets us skip gracefully if the row already exists.
    const existingNode = await prisma.generationTree.findUnique({
      where: { uplineUserId: user.id },
    });

    if (existingNode) {
      console.log(`ℹ️  Tree node already exists for ${normalizedAddress} — skipping`);
      return;
    }

    try {
      await prisma.generationTree.create({
        data: {
          uplineAddress:    normalizedUpline,
          uplineUserId:     user.id,
          leftChildAddress:  null,
          leftUserId:        null,
          rightChildAddress: null,
          rightUserId:       null,
        },
      });
      console.log(
        `✅ User's own tree node created: ${normalizedAddress} (upline: ${normalizedUpline})`
      );
    } catch (err: any) {
      // P2002 = another concurrent call already created this node — safe to ignore
      if (err.code === 'P2002') {
        console.log(`ℹ️  Tree node already created concurrently for ${normalizedAddress} — skipping`);
        return;
      }
      throw err;
    }

  } catch (error: any) {
    console.error('❌ generationTreeService error:', error.message);
    throw error;
  }
};