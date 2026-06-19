-- CreateTable
CREATE TABLE "PackageUpgrade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "amountUsed" TEXT NOT NULL,
    "packageCost" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageUpgrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackageUpgrade_userId_createdAt_idx" ON "PackageUpgrade"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PackageUpgrade_userAddress_idx" ON "PackageUpgrade"("userAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PackageUpgrade_transactionHash_packageNumber_userId_key" ON "PackageUpgrade"("transactionHash", "packageNumber", "userId");

-- AddForeignKey
ALTER TABLE "PackageUpgrade" ADD CONSTRAINT "PackageUpgrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
