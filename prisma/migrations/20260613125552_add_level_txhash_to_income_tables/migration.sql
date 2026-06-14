/*
  Warnings:

  - You are about to drop the column `level` on the `GenerationTree` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[fromUserAddress,transactionHash,packageNumber]` on the table `DirectIncome` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[fromUserAddress,transactionHash,packageNumber]` on the table `GenerationIncome` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[transactionHash,packageNumber,fromUserAddress]` on the table `LapsIncome` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `transactionHash` to the `LapsIncome` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "DirectIncome_transactionHash_packageNumber_key";

-- DropIndex
DROP INDEX "GenerationIncome_transactionHash_packageNumber_key";

-- AlterTable
ALTER TABLE "GenerationIncome" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GenerationTree" DROP COLUMN "level";

-- AlterTable
ALTER TABLE "LapsIncome" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transactionHash" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "SyncMeta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncMeta_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "DirectIncome_fromUserAddress_transactionHash_packageNumber_key" ON "DirectIncome"("fromUserAddress", "transactionHash", "packageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationIncome_fromUserAddress_transactionHash_packageNum_key" ON "GenerationIncome"("fromUserAddress", "transactionHash", "packageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LapsIncome_transactionHash_packageNumber_fromUserAddress_key" ON "LapsIncome"("transactionHash", "packageNumber", "fromUserAddress");
