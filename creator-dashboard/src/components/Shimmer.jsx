import React, { memo, useLayoutEffect, useRef, useState } from "react";
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

function ShimmerComponent({ children, as: Element = "p", className, speed = 43, spread = 40 }) {
  const MotionElement = getMotionComponent(Element);
  const elementRef = useRef(null);
  const [elementWidth, setElementWidth] = useState(0);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const updateWidth = () => setElementWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(updateWidth);
    updateWidth();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const animationDuration = elementWidth > 0 ? elementWidth * 1.5 / speed : 100 * 1.5 / speed;

  return <MotionElement
    ref={elementRef}
    animate={{ backgroundPosition: "0% center" }}
    className={twMerge(clsx("web-chat__shimmer", className))}
    initial={{ backgroundPosition: "100% center" }}
    style={{
      "--spread": `${spread}px`,
      backgroundImage: "var(--bg), linear-gradient(var(--chat-ink), var(--chat-ink))"
    }}
    transition={{ duration: animationDuration, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
  >
    {children}
  </MotionElement>;
}

export const Shimmer = memo(ShimmerComponent);
