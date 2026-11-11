/** A message the Assistant did not get from the Expert has a client message id that starts with this. */
export const SYSTEM_MESSAGE_PREFIX = "sys:";
export const isSystemMessageId = (id: string | undefined): boolean => Boolean(id?.startsWith(SYSTEM_MESSAGE_PREFIX));
