import { HatchError } from "./errors.js";

export const need = (command, args, min) => {
  if (args._.length < min) throw new HatchError(`Usage: hatch ${command.usage}`, { code: "usage" });
  return args._;
};
export const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
