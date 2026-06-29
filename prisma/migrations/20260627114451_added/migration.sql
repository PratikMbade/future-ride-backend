-- CreateTable
CREATE TABLE "RoyaltyIncome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountClaim" DOUBLE PRECISION NOT NULL,
    "poolNumber" INTEGER NOT NULL,
    "timestamp" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transactionHash" TEXT NOT NULL,

    CONSTRAINT "RoyaltyIncome_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RoyaltyIncome" ADD CONSTRAINT "RoyaltyIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
