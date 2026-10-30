-- CreateTable
CREATE TABLE "LegacyIdMap" (
    "source" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "newId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyIdMap_pkey" PRIMARY KEY ("source","legacyId","entity")
);

-- CreateIndex
CREATE INDEX "LegacyIdMap_entity_newId_idx" ON "LegacyIdMap"("entity", "newId");
