// src/controllers/treeController.ts
import { Request, Response } from 'express';
import { prisma } from '..';

interface TreeNodeResponse {
  id:              string;
  address:         string;
  referralAddress: string;
  contractRegId:   number | null;
  isRegistered:    boolean;
  left:            TreeNodeResponse | null;
  right:           TreeNodeResponse | null;
}

// ─────────────────────────────────────────────────────────
//  Fetch ALL tree nodes in ONE query, then build in memory
//  This avoids N+1 recursive DB calls
// ─────────────────────────────────────────────────────────
async function buildFullTree(
  rootUserId: string,
  maxDepth:   number = 10,
): Promise<TreeNodeResponse | null> {

  // 1. pull ALL GenerationTree rows in one query
  const allTreeNodes = await prisma.generationTree.findMany({
    select: {
      uplineUserId:  true,
      leftUserId:    true,
      rightUserId:   true,
    },
  });

  // 2. pull ALL users referenced in the tree in one query
  const allUserIds = new Set<string>();
  for (const node of allTreeNodes) {
    allUserIds.add(node.uplineUserId);
    if (node.leftUserId)  allUserIds.add(node.leftUserId);
    if (node.rightUserId) allUserIds.add(node.rightUserId);
  }

  const allUsers = await prisma.user.findMany({
    where: { id: { in: Array.from(allUserIds) } },
    select: {
      id:             true,
      userAddress:    true,
      referalAddress: true,
      contractRegId:  true,
      isRegistered:   true,
    },
  });

  // 3. build lookup maps — O(1) access
  const userMap   = new Map(allUsers.map(u => [u.id, u]));
  const treeMap   = new Map(allTreeNodes.map(n => [n.uplineUserId, n]));

  // 4. recursive builder — pure in-memory, no more DB calls
  function buildNode(userId: string, depth: number): TreeNodeResponse | null {
    if (depth > maxDepth) return null;

    const user = userMap.get(userId);
    if (!user) return null;

    const node = treeMap.get(userId);

    return {
      id:              user.id,
      address:         user.userAddress,
      referralAddress: user.referalAddress ?? '',
      contractRegId:   user.contractRegId ?? null,
      isRegistered:    user.isRegistered,
      left:  node?.leftUserId  ? buildNode(node.leftUserId,  depth + 1) : null,
      right: node?.rightUserId ? buildNode(node.rightUserId, depth + 1) : null,
    };
  }

  return buildNode(rootUserId, 0);
}

// ─────────────────────────────────────────────────────────
//  GET /api/tree/:userAddress
//  Returns the full subtree rooted at the given user
// ─────────────────────────────────────────────────────────
export const getGenerationTree = async (req: Request, res: Response) => {
  try {
    const userAddress = String(req.params.userAddress ?? '').toLowerCase().trim();
    const maxDepth    = Math.min(parseInt(req.query.depth as string) || 10, 15);

    if (!userAddress || !userAddress.startsWith('0x')) {
      res.status(400).json({ error: 'Valid userAddress is required' });
      return;
    }

    // find the user
    const user = await prisma.user.findUnique({
      where:  { userAddress },
      select: { id: true, isRegistered: true },
    });

    if (!user) {
      res.status(404).json({ error: `User ${userAddress} not found` });
      return;
    }

    // build tree
    const tree = await buildFullTree(user.id, maxDepth);

    if (!tree) {
      res.status(404).json({ error: 'Generation tree not found for this user' });
      return;
    }

    res.status(200).json({
      success:    true,
      userAddress,
      tree,
    });

  } catch (error: any) {
    console.error('getGenerationTree error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};