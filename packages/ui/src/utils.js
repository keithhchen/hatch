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

export function avatarLetter(value = "") {
  const letter = String(value).trim().slice(0, 1);
  if (!letter) return "H";
  const upper = letter.toLocaleUpperCase();
  return Array.from(upper).length === 1 ? upper : letter;
}
