-- CreateTable
CREATE TABLE "LostIncome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lapsedAddress" TEXT NOT NULL,
    "redirectedToAddress" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "timestamp" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LostIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LostIncome_userId_idx" ON "LostIncome"("userId");

-- CreateIndex
CREATE INDEX "LostIncome_lapsedAddress_idx" ON "LostIncome"("lapsedAddress");

-- CreateIndex
CREATE UNIQUE INDEX "LostIncome_transactionHash_packageNumber_lapsedAddress_key" ON "LostIncome"("transactionHash", "packageNumber", "lapsedAddress");

-- AddForeignKey
ALTER TABLE "LostIncome" ADD CONSTRAINT "LostIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
