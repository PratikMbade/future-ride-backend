/*
  Warnings:

  - You are about to drop the column `ficonId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `PackageUpgrade` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PackageUpgrade" DROP CONSTRAINT "PackageUpgrade_userId_fkey";

-- DropIndex
DROP INDEX "Package_packageBuyTranxHash_key";

-- DropIndex
DROP INDEX "User_ficonId_key";

-- DropIndex
DROP INDEX "User_ficonId_userAddress_contractRegId_idx";

-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "packageContractBuyId" INTEGER;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "ficonId";

-- DropTable
DROP TABLE "PackageUpgrade";

-- CreateIndex
CREATE INDEX "User_userAddress_contractRegId_idx" ON "User"("userAddress", "contractRegId");
