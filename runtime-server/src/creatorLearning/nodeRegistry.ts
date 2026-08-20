import { aboutYouNode } from "./aboutYouNode.js";
import { corpusNode } from "./corpusNode.js";

/** Product-facing Factory Nodes. Every entry uses the same NodeRuntime. */
export const factoryNodes = {
  "about-you": aboutYouNode,
  corpus: corpusNode
} as const;

export type FactoryNodeName = keyof typeof factoryNodes;
export type FactoryNode = typeof factoryNodes[FactoryNodeName];

export function getFactoryNode(name: string): FactoryNode {
  if (isFactoryNodeName(name)) return factoryNodes[name];
  throw new Error(`Unknown Factory node: ${name}`);
}

export function isFactoryNodeName(value: string): value is FactoryNodeName {
  return Object.prototype.hasOwnProperty.call(factoryNodes, value);
}
