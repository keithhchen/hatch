import { aboutYouNode } from "./aboutYouNode.js";
import { corpusNode } from "./corpusNode.js";

/** The product-facing Factory nodes share one runtime and one persistence model. */
export const factoryNodes = {
  "about-you": aboutYouNode,
  corpus: corpusNode
} as const;

export type FactoryNodeName = keyof typeof factoryNodes;
export type FactoryNode = typeof factoryNodes[FactoryNodeName];

export function getFactoryNode(name: string): FactoryNode {
  const node = isFactoryNodeName(name) ? factoryNodes[name] : undefined;
  if (!node) throw new Error(`Unknown Factory node: ${name}`);
  return node;
}

export function isFactoryNodeName(value: string): value is FactoryNodeName {
  return Object.prototype.hasOwnProperty.call(factoryNodes, value);
}
