import { prismaAdapter } from "better-auth/adapters/prisma"
import { isUserExist } from "../utils/userMethod"
import { prisma } from ".."
import { generationTreeService } from "./generationtree.service";




export const registerUserService = async (userAddress: string, referralAddress: string, contractRegId: number) => {
    try {

        const normalizedAddress = userAddress.toLowerCase();
        const normalizedReferral = referralAddress.toLowerCase();

        const isUserAlreadyRegistered = await prisma.user.findUnique({
            where: {
                userAddress: userAddress
            }
        })

        if (isUserAlreadyRegistered?.isRegistered === true) throw new Error("User already registered in contract ");

        //check referral exist in DB
        const isReferralExist = await isUserExist(normalizedReferral);
        if (!isReferralExist) throw new Error('Referral not present in DB');

        // upsert — handles both cases:
        // 1. user connected wallet before (row exists, update it)
        // 2. user never visited before (create fresh row)
        const user = await prisma.user.upsert({
            where: {
                userAddress: normalizedAddress,
            },
            update: {
                referalAddress: normalizedReferral,
                contractRegId,
                isRegistered: true,
            },
            create: {
                userAddress: normalizedAddress,
                referalAddress: normalizedReferral,
                contractRegId,
                isRegistered: true,
            },
        });
        console.log(`✅ User registered in DB: ${normalizedAddress}`);

        // now call Generation Tree 
        generationTreeService(normalizedAddress);
        return user;
    } catch (error: any) {
        console.error('❌ registerUserService error:', error.message);
        throw error;

    }
}