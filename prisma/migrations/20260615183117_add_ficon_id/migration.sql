/*
  Warnings:

  - A unique constraint covering the columns `[ficonId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `ficonId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "User_userAddress_contractRegId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ficonId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_ficonId_key" ON "User"("ficonId");

-- CreateIndex
CREATE INDEX "User_ficonId_userAddress_contractRegId_idx" ON "User"("ficonId", "userAddress", "contractRegId");
