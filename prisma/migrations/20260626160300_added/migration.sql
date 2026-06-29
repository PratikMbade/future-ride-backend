-- DropIndex
DROP INDEX "User_userAddress_contractRegId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "futureRideId" TEXT;

-- CreateIndex
CREATE INDEX "Package_packageBuyTranxHash_idx" ON "Package"("packageBuyTranxHash");

-- CreateIndex
CREATE INDEX "User_userAddress_contractRegId_futureRideId_idx" ON "User"("userAddress", "contractRegId", "futureRideId");
