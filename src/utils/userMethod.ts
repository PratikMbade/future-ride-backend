import { prisma } from "..";



export async function isUserExist(userAddress:string) {
    try {
        const user = await prisma.user.findUnique({
            where:{
                userAddress:userAddress.toLowerCase()
            }
        })

        if(!user) return null;

        return user
    } catch (error) {
        console.log('something went wrong in isUserExist ',error);
        return null;
    }
}
