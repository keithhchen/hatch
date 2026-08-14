import React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./Button.jsx";
import { cn, initials } from "./utils.js";

export function Avatar({ src, alt = "", name, fallback, size = "medium", className }) {
  return <AvatarPrimitive.Root className={cn("hui-avatar", `is-${size}`, className)}><AvatarPrimitive.Image src={src} alt={alt} /><AvatarPrimitive.Fallback delayMs={src ? 300 : 0}>{fallback || initials(name)}</AvatarPrimitive.Fallback></AvatarPrimitive.Root>;
}
export function AvatarGroup({ people, max = 4, size = "medium", className }) {
  const visible = people.slice(0, max);
  const remainder = people.length - visible.length;
  return <div className={cn("hui-avatar-group", className)} aria-label={people.map((person) => person.name).join(", ")}>{visible.map((person) => <Avatar {...person} size={size} key={person.id || person.name} />)}{remainder > 0 ? <span className={cn("hui-avatar hui-avatar-more", `is-${size}`)}>+{remainder}</span> : null}</div>;
}

export function DataTable({ columns, rows, rowKey = "id", onRowClick, empty, caption, className }) {
  if (!rows.length && empty) return empty;
  return <div className={cn("hui-table-wrap", className)}><table className="hui-table">{caption ? <caption>{caption}</caption> : null}<thead><tr>{columns.map((column) => <th scope="col" className={column.align ? `is-${column.align}` : undefined} key={column.key}>{column.header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={typeof rowKey === "function" ? rowKey(row) : row[rowKey] ?? rowIndex} className={onRowClick ? "is-clickable" : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>{columns.map((column) => <td className={column.align ? `is-${column.align}` : undefined} key={column.key}>{column.render ? column.render(row) : row[column.key]}</td>)}</tr>)}</tbody></table></div>;
}

export function List({ items, renderItem, getKey = (item, index) => item.id ?? index, ordered = false, className, ariaLabel }) {
  const Component = ordered ? "ol" : "ul";
  return <Component className={cn("hui-list", className)} aria-label={ariaLabel}>{items.map((item, index) => <li key={getKey(item, index)}>{renderItem(item, index)}</li>)}</Component>;
}

export function Pagination({ page, pageCount, onPageChange, className, label = "Pagination" }) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1).filter((value) => value === 1 || value === pageCount || Math.abs(value - page) <= 1);
  const sequence = pages.reduce((items, value, index) => {
    if (index && value - pages[index - 1] > 1) items.push(`gap-${value}`);
    items.push(value);
    return items;
  }, []);
  return <nav className={cn("hui-pagination", className)} aria-label={label}><IconButton label="Previous page" size="small" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft aria-hidden="true" /></IconButton>{sequence.map((value) => typeof value === "string" ? <span key={value}>…</span> : <button type="button" className={value === page ? "is-current" : undefined} aria-current={value === page ? "page" : undefined} onClick={() => onPageChange(value)} key={value}>{value}</button>)}<IconButton label="Next page" size="small" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}><ChevronRight aria-hidden="true" /></IconButton></nav>;
}
