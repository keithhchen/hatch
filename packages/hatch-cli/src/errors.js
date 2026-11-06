export class HatchError extends Error {
  constructor(message, { code = "error", status } = {}) {
    super(message);
    this.name = "HatchError";
    this.code = code;
    this.status = status;
  }
}
