/*
  Warnings:

  - A unique constraint covering the columns `[userAddress]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `userAddress` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "userAddress" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "packageAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "packageBuyTranxHash" TEXT NOT NULL,
    "tranxHash" TEXT NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectIncome" (
    "id" TEXT NOT NULL,
    "fromUserAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationIncome" (
    "id" TEXT NOT NULL,
    "fromUserAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationTree" (
    "id" TEXT NOT NULL,
    "uplineAddress" TEXT NOT NULL,
    "uplineUserId" TEXT NOT NULL,
    "leftChildAddress" TEXT NOT NULL,
    "leftUserId" TEXT NOT NULL,
    "rightChildAddress" TEXT NOT NULL,
    "rightUserId" TEXT NOT NULL,

    CONSTRAINT "GenerationTree_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LapsIncome" (
    "id" TEXT NOT NULL,
    "fromUserAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LapsIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Package_packageBuyTranxHash_key" ON "Package"("packageBuyTranxHash");

-- CreateIndex
CREATE UNIQUE INDEX "Package_userId_tranxHash_packageNumber_key" ON "Package"("userId", "tranxHash", "packageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_userAddress_key" ON "User"("userAddress");

-- CreateIndex
CREATE INDEX "User_userAddress_contractRegId_idx" ON "User"("userAddress", "contractRegId");

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectIncome" ADD CONSTRAINT "DirectIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationIncome" ADD CONSTRAINT "GenerationIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationTree" ADD CONSTRAINT "GenerationTree_uplineUserId_fkey" FOREIGN KEY ("uplineUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationTree" ADD CONSTRAINT "GenerationTree_leftUserId_fkey" FOREIGN KEY ("leftUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationTree" ADD CONSTRAINT "GenerationTree_rightUserId_fkey" FOREIGN KEY ("rightUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LapsIncome" ADD CONSTRAINT "LapsIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
