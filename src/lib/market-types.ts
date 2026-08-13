import type { MarketPlatform, MarketSellerType } from "@prisma/client";

export type MarketCard = {
  platform: MarketPlatform;
  externalId: string;
  url: string;
  sellerType: MarketSellerType;
  propertyType: string;
  dealType: string;
  city: string;
  district: string;
  street: string;
  streetNumber: string;
  area: string;
  rooms: string;
  floor: string;
  cadastralCode: string;
  price: string;
  currency: string;
  title: string;
  imageUrl: string;
  sourcePostedAt: Date | null;
};

export type MarketSellerSlice = "owner" | "agency";
