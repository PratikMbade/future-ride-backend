-- CreateTable
CREATE TABLE "UpgradeHolding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "fromUserAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpgradeHolding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpgradeHolding_userId_createdAt_idx" ON "UpgradeHolding"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "UpgradeHolding_userAddress_idx" ON "UpgradeHolding"("userAddress");

-- CreateIndex
CREATE INDEX "UpgradeHolding_fromUserAddress_idx" ON "UpgradeHolding"("fromUserAddress");

-- CreateIndex
CREATE UNIQUE INDEX "UpgradeHolding_transactionHash_packageNumber_userId_key" ON "UpgradeHolding"("transactionHash", "packageNumber", "userId");

-- AddForeignKey
ALTER TABLE "UpgradeHolding" ADD CONSTRAINT "UpgradeHolding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
