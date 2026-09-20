-- Phase 11 item 4: users with a password hash for JWT login (the three demo tokens stay valid as a fallback).
CREATE TABLE "user" (
  "user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_pkey" PRIMARY KEY ("user_id")
);
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
