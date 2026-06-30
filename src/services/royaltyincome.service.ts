import { prisma } from "../lib/prisma";





export const royaltyIncomeService = async (
    userAddress: string,
    amountClaim: string,
    poolNumber: number,
    timestamp: number,
    transactionHash: string
) => {

    try {

        const normalizedAddress = userAddress.toLowerCase();
        const normalizedTxHash = transactionHash.toLowerCase();

        //check user present or not

        const user = await prisma.user.findFirst({
            where: {
                userAddress: normalizedAddress
            },
            select: {
                id: true
            }
        })

        if (!user) {
            console.warn(`⚠️  [RoyaltyIncome] User ${normalizedAddress} not found in DB — skipping claim PKG${poolNumber}`);
            return null;
        }


        //idempotency => same (user,tx,pool)
        const existing = await prisma.royaltyIncome.findFirst({
            where: {
                userId: user.id,
                transactionHash: normalizedTxHash,
                poolNumber,
            },
        });

        if (existing) {
            console.log(`ℹ️  [RoyaltyIncome] Already recorded for ${normalizedAddress} PKG${poolNumber} tx:${normalizedTxHash}`);
            return existing;
        }

        const newRoyaltyIncome = await prisma.royaltyIncome.create({
            data: {
                userId: user.id,
                amountClaim: parseFloat(amountClaim),
                poolNumber,
                timestamp: String(timestamp),
                transactionHash: normalizedTxHash
            }
        })

        console.log(`✅ [RoyaltyIncome] ${normalizedAddress} claimed ${amountClaim} from PKG${poolNumber} (tx:${normalizedTxHash})`);
        return newRoyaltyIncome;




    } catch (error) {
        if (error.code === 'P2002') {
            console.log(`ℹ️  [RoyaltyIncome] Already recorded (concurrent write) for ${userAddress.toLowerCase()} PKG${poolNumber}`);
            return null;
        }
        console.error('royaltyIncomeService error:', error.message);
        throw error;
    }
}