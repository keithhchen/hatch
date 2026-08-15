import { clsx } from "clsx";

export function cn(...values) {
  return clsx(values);
}
export function initials(value = "") {
  return String(value)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "H";
}
