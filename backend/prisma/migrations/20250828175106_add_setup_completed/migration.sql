/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `hotels` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone]` on the table `hotels` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[owner_email]` on the table `hotels` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."hotels" ADD COLUMN     "setup_completed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "hotels_name_key" ON "public"."hotels"("name");

-- CreateIndex
CREATE UNIQUE INDEX "hotels_phone_key" ON "public"."hotels"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "hotels_owner_email_key" ON "public"."hotels"("owner_email");
