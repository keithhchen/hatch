import React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { ChevronDown, ChevronRight, Home } from "lucide-react";
import { cn } from "./utils.js";

export function Tabs({ value, defaultValue, onValueChange, items, ariaLabel, className }) {
  return (
    <TabsPrimitive.Root className={cn("hui-tabs", className)} value={value} defaultValue={defaultValue} onValueChange={onValueChange}>
      <TabsPrimitive.List aria-label={ariaLabel}>{items.map((item) => <TabsPrimitive.Trigger value={item.value} disabled={item.disabled} key={item.value}>{item.label}</TabsPrimitive.Trigger>)}</TabsPrimitive.List>
      {items.map((item) => item.content === undefined ? null : <TabsPrimitive.Content value={item.value} key={item.value}>{item.content}</TabsPrimitive.Content>)}
    </TabsPrimitive.Root>
  );
}

export function SegmentedControl({ value, defaultValue, onValueChange, items, ariaLabel, className }) {
  return <Tabs className={cn("hui-segmented", className)} value={value} defaultValue={defaultValue} onValueChange={onValueChange} items={items} ariaLabel={ariaLabel} />;
}

export function Breadcrumbs({ items, className }) {
  return (
    <nav className={cn("hui-breadcrumbs", className)} aria-label="Breadcrumb">
      <ol>{items.map((item, index) => <li key={item.href || item.label}>{index ? <ChevronRight aria-hidden="true" /> : null}{item.href ? <a href={item.href} onClick={item.onClick}>{index === 0 && item.icon !== false ? <Home aria-hidden="true" /> : null}{item.label}</a> : <span aria-current="page">{item.label}</span>}</li>)}</ol>
    </nav>
  );
}

export function NavigationItem({ active = false, icon, count, children, className, ...props }) {
  const Component = props.href ? "a" : "button";
  return <Component className={cn("hui-navigation-item", active && "is-active", className)} aria-current={active ? "page" : undefined} type={Component === "button" ? "button" : undefined} {...props}>{icon}<span>{children}</span>{count !== undefined ? <b>{count}</b> : null}</Component>;
}

export function Sidebar({ brand, primary, secondary, account, className }) {
  return <aside className={cn("hui-sidebar", className)}>{brand}<nav aria-label="Primary navigation">{primary}</nav>{secondary ? <nav className="hui-sidebar__secondary" aria-label="Secondary navigation">{secondary}</nav> : null}{account ? <div className="hui-sidebar__account">{account}</div> : null}</aside>;
}

export function Accordion({ items, type = "single", collapsible = true, defaultValue, className }) {
  return (
    <AccordionPrimitive.Root className={cn("hui-accordion", className)} type={type} collapsible={type === "single" ? collapsible : undefined} defaultValue={defaultValue}>
      {items.map((item) => <AccordionPrimitive.Item value={item.value} key={item.value}><AccordionPrimitive.Header><AccordionPrimitive.Trigger>{item.title}<ChevronDown aria-hidden="true" /></AccordionPrimitive.Trigger></AccordionPrimitive.Header><AccordionPrimitive.Content><div>{item.content}</div></AccordionPrimitive.Content></AccordionPrimitive.Item>)}
    </AccordionPrimitive.Root>
  );
}

export const Disclosure = Accordion;
