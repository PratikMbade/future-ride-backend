



// getMe -> user info related to acccount card

import { Request, Response } from "express";
import { prisma } from "..";

async function countCommunity(rootUserId:string):Promise<number>{

    const allNodes = await prisma.generationTree.findMany({
        select:{
            uplineUserId:true,
            leftUserId:true,
            rightUserId:true
        }
    })

    const childMap = new Map<string,string[]>();
    for(const node of allNodes){
        const children : string[] = [];
        if(node.leftUserId) children.push(node.leftUserId);
        if(node.rightUserId) children.push(node.rightUserId);
        if(children.length > 0){
            childMap.set(node.uplineUserId,children);

        }
    }

    let count = 0;
    const queue = [rootUserId];
    const seen = new Set<string>([rootUserId]);
    while(queue.length > 0){
        const current = queue.shift()!;
        const children = childMap.get(current)??[];

        for(const child of children){
            if(!seen.has(child)){
                seen.add(child);
                queue.push(child);
                count++;
            }
        }
    }

    return count;
}



export const getMe = async(req:Request,res:Response)=>{
    try {
        const dbUser = (req as any).dbUser;
     
        // get user highest pacakge bought date
        const highestPkg = await prisma.package.findFirst({
            where:{ userId:dbUser.id },
            orderBy:{packageNumber:'desc'},
            select:{packageNumber:true,createdAt:true}
        })

        //direct team count
        const directTeamCount = await prisma.user.count({
            where:{
                referalAddress:dbUser.userAddress,
                isRegistered:true
            }
        });

        // total community (all descendants in gen tree)
        const communityCount = await countCommunity(dbUser.id);
       
          const baseUrl      = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const referralLink = `${baseUrl}/registration?ref=${dbUser.ficonId}`;
 
    // ── 5. referred by (sponsor address) ─────────────────
    // referalAddress is the sponsor's wallet address
    const referredBy = dbUser.referalAddress === dbUser.userAddress
      ? null                     // owner refers to themselves — show "No sponsor"
      : dbUser.referalAddress;
 
    res.status(200).json({
      success: true,
 
      // account card
      highestPackage:      highestPkg?.packageNumber    ?? 0,
      packagePurchaseDate: highestPkg?.createdAt?.toISOString() ?? new Date().toISOString(),
      referredBy,
      referralLink,
      directTeamCount,
      totalCommunityTeam:  communityCount,
 
      // other dashboard fields
      userAddress:   dbUser.userAddress,
      contractRegId: dbUser.contractRegId,
      isRegistered:  dbUser.isRegistered,
 
      // wallet balance — from contract or stored (placeholder for now)
      walletFundBalance: 0,
    });

        
    } catch (error:any) {
  console.error('getMe error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
    }
}


export const getDirectTeam = async (req:Request,res:Response) =>{
   try {
    const dbUser  = (req as any).dbUser;
    const page     = Math.max(1, parseInt(req.query.page  as string) || 1);
    const pageSize = Math.min(50, parseInt(req.query.limit as string) || 15);
    const skip     = (page - 1) * pageSize;
    const search   = (req.query.search  as string ?? '').toLowerCase().trim();
    const pkgFilter = parseInt(req.query.package as string) || 0; // 0 = all
 
    // ── base filter ──────────────────────────────────────
    const where: any = {
      referalAddress: dbUser.userAddress,
      isRegistered:   true,
      ...(search ? { userAddress: { contains: search, mode: 'insensitive' } } : {}),
    };
 
    // ── package filter ────────────────────────────────────
    // Filter users who have bought at least the selected package number
    if (pkgFilter > 0) {
      where.packages = {
        some: {
          packageNumber: pkgFilter,
        },
      };
    }
 
    const [members, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take:    pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id:            true,
          userAddress:   true,
          contractRegId: true,
          isRegistered:  true,
          createdAt:     true,
          packages: {
            orderBy: { packageNumber: 'desc' },
            take:    1,
            select:  { packageNumber: true, packageName: true },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);
 
    // sub-team count for each member
    const memberAddresses = members.map(m => m.userAddress);
    const subCounts = await prisma.user.groupBy({
      by:    ['referalAddress'],
      where: { referalAddress: { in: memberAddresses }, isRegistered: true },
      _count: { _all: true },
    });
    const subMap = new Map(subCounts.map(r => [r.referalAddress, r._count._all]));
 
    const rows = members.map((m, idx) => ({
      id:             m.id,
      rank:           skip + idx + 1,
      userAddress:    m.userAddress,
      contractRegId:  m.contractRegId,
      isRegistered:   m.isRegistered,
      joinedAt:       m.createdAt.toISOString(),
      highestPackage: m.packages[0]?.packageNumber ?? 0,
      packageName:    m.packages[0]?.packageName   ?? 'None',
      directTeam:     subMap.get(m.userAddress)    ?? 0,
    }));
 
    res.json({
      success:    true,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      members:    rows,
    });
 
  } catch (error: any) {
    console.error('direct-team error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}