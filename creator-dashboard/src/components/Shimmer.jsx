import React, { memo, useMemo } from "react";
import { motion } from "motion/react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const motionComponentCache = new Map();

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
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

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
