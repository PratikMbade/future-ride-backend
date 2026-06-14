/*
  Warnings:

  - A unique constraint covering the columns `[transactionHash,packageNumber]` on the table `DirectIncome` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[transactionHash,packageNumber]` on the table `GenerationIncome` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[uplineUserId]` on the table `GenerationTree` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `transactionHash` to the `DirectIncome` table without a default value. This is not possible if the table is not empty.
  - Added the required column `transactionHash` to the `GenerationIncome` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DirectIncome" ADD COLUMN     "transactionHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "GenerationIncome" ADD COLUMN     "transactionHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "GenerationTree" ALTER COLUMN "leftChildAddress" DROP NOT NULL,
ALTER COLUMN "leftUserId" DROP NOT NULL,
ALTER COLUMN "rightChildAddress" DROP NOT NULL,
ALTER COLUMN "rightUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DirectIncome_transactionHash_packageNumber_key" ON "DirectIncome"("transactionHash", "packageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationIncome_transactionHash_packageNumber_key" ON "GenerationIncome"("transactionHash", "packageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationTree_uplineUserId_key" ON "GenerationTree"("uplineUserId");
