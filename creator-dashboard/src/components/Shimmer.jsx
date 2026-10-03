import React, { Children, isValidElement, memo, useMemo } from "react";
import { motion } from "motion/react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const motionComponentCache = new Map();

function textCharacterCount(children) {
  return Children.toArray(children).reduce((count, child) => {
    if (typeof child === "string" || typeof child === "number") return count + Array.from(String(child)).length;
    return isValidElement(child) ? count + textCharacterCount(child.props.children) : count;
  }, 0);
}

function getMotionComponent(element) {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
}

function ShimmerComponent({ children, as: Element = "p", className, duration = 2, spread = 2 }) {
  const MotionElement = getMotionComponent(Element);
  const dynamicSpread = useMemo(() => textCharacterCount(children) * spread, [children, spread]);

  return <MotionElement
    animate={{ backgroundPosition: "0% center" }}
    className={twMerge(clsx("web-chat__shimmer", className))}
    initial={{ backgroundPosition: "100% center" }}
    style={{
      "--spread": `${dynamicSpread}px`,
      backgroundImage: "var(--bg), linear-gradient(var(--chat-ink), var(--chat-ink))"
    }}
    transition={{ duration, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
  >
    {children}
  </MotionElement>;
}

export const Shimmer = memo(ShimmerComponent);
