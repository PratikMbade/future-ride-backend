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
    const genStr = await contract.InternalGenStr(userAddress);
    const uplineAddress = genStr.upline as string;

    if (!uplineAddress || uplineAddress === ethers.constants.AddressZero) {
      console.log(`ℹ️ ${userAddress} has no upline (root user)`);
      return;
    }

    const normalizedUpline = uplineAddress.toLowerCase();

    // 3. find upline user in DB
    const uplineUser = await prisma.user.findUnique({
      where: { userAddress: normalizedUpline },
    });
    if (!uplineUser) throw new Error(`Upline ${uplineAddress} not found in DB`);

    // 4. read upline's InternalGenStr to get left/right positions + grandparent
    const uplineGenStr = await contract.InternalGenStr(uplineAddress);
    const leftAddress = (uplineGenStr.left as string).toLowerCase();
    const rightAddress = (uplineGenStr.right as string).toLowerCase();
    const grandParentAddress = (uplineGenStr.upline as string).toLowerCase();

    const isLeft = leftAddress === normalizedAddress;
    const isRight = rightAddress === normalizedAddress;

    if (!isLeft && !isRight) {
      throw new Error(
        `${userAddress} is neither left nor right child of ${uplineAddress}`
      );
    }

    // 5. find grandparent user in DB (for create fallback in step 6)
    const grandParentUser =
      grandParentAddress && grandParentAddress !== ethers.constants.AddressZero
        ? await prisma.user.findUnique({
            where: { userAddress: grandParentAddress },
          })
        : null;

    // 6. update upline's GenerationTree row — set this user as left or right child
    //    uplineUserId = uplineUser.id (this row belongs to the upline node)
    //    uplineAddress in create = grandparent's address (upline's own upline)
    await prisma.generationTree.upsert({
      where: { uplineUserId: uplineUser.id },
      update: {
        ...(isLeft && {
          leftChildAddress: normalizedAddress,
          leftUserId: user.id,
        }),
        ...(isRight && {
          rightChildAddress: normalizedAddress,
          rightUserId: user.id,
        }),
      },
      create: {
        uplineAddress: grandParentAddress,                  // upline's own parent
        uplineUserId: uplineUser.id,                        // this node = upline
        leftChildAddress: isLeft ? normalizedAddress : null,
        leftUserId: isLeft ? user.id : null,
        rightChildAddress: isRight ? normalizedAddress : null,
        rightUserId: isRight ? user.id : null,
      },
    });

    console.log(
      `✅ Upline tree updated: ${normalizedUpline} → ${isLeft ? "LEFT" : "RIGHT"}: ${normalizedAddress}`
    );

    // 7. create this user's own GenerationTree node
    //    - uplineUserId = user.id  (this node belongs to the new user)
    //    - uplineAddress = normalizedUpline (who is above this user)
    //    - children = null (no children yet)
    await prisma.generationTree.upsert({
      where: { uplineUserId: user.id },   // find by this user's id
      update: {},                          // already exists — nothing to change
      create: {
        uplineAddress: normalizedUpline,   // their upline's address
        uplineUserId: user.id,             // ← MUST match where key
        leftChildAddress: null,
        leftUserId: null,
        rightChildAddress: null,
        rightUserId: null,
      },
    });

    console.log(
      `✅ User's own tree node created: ${normalizedAddress} (upline: ${normalizedUpline})`
    );

  } catch (error) {
    console.error("❌ generationTreeService error:", error);
    throw error;
  }
};