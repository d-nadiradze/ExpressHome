import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("ka-GE", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isValidMyhomeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("myhome.ge");
  } catch {
    return false;
  }
}

export function isValidSsgeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes("ss.ge") &&
      parsed.pathname.includes("/udzravi-qoneba/")
    );
  } catch {
    return false;
  }
}

export function isValidListingUrl(url: string): boolean {
  return isValidMyhomeUrl(url) || isValidSsgeUrl(url);
}
