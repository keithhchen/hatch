/**
 * Feishu and Lark's long connection: the platform pushes events over a WebSocket we open, so no public URL is needed.
 * The wire format is the platform's protobuf `pbbp2.Frame`, read from the official SDK (@larksuiteoapi/node-sdk, ws/).
 */
export type Frame = { SeqID: number; LogID: number; service: number; method: number; headers: Array<{ key: string; value: string }>; payload?: Buffer };

const CONTROL = 0;
const DATA = 1;

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) { bytes.push((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
  return [...bytes, rest];
}
const field = (id: number, wire: number, body: number[] | Buffer) => [...varint(id * 8 + wire), ...(wire === 2 ? varint(body.length) : []), ...body];
const text = (id: number, value: string) => field(id, 2, Buffer.from(value));

export function encodeFrame(frame: Frame): Buffer {
  return Buffer.from([
    ...field(1, 0, varint(frame.SeqID)), ...field(2, 0, varint(frame.LogID)), ...field(3, 0, varint(frame.service)), ...field(4, 0, varint(frame.method)),
    ...frame.headers.flatMap(header => field(5, 2, [...text(1, header.key), ...text(2, header.value)])),
    ...(frame.payload ? field(8, 2, frame.payload) : []),
  ]);
}

/** Reads each field as a number (wire type 0) or bytes (wire type 2). */
function* fields(bytes: Buffer): Generator<[number, number | Buffer]> {
  let at = 0;
  const read = () => { let value = 0; let scale = 1; for (;;) { const byte = bytes[at++]!; value += (byte & 0x7f) * scale; if (byte < 0x80) return value; scale *= 0x80; } };
  while (at < bytes.length) {
    const tag = read();
    if (tag % 8 === 0) yield [Math.floor(tag / 8), read()];
    else if (tag % 8 === 2) { const length = read(); yield [Math.floor(tag / 8), bytes.subarray(at, at + length)]; at += length; }
    else throw new Error("Unsupported frame field");
  }
}

export function decodeFrame(bytes: Buffer): Frame {
  const frame: Frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] };
  for (const [id, value] of fields(bytes)) {
    if (id === 1) frame.SeqID = value as number;
    else if (id === 2) frame.LogID = value as number;
    else if (id === 3) frame.service = value as number;
    else if (id === 4) frame.method = value as number;
    else if (id === 5) {
      const header = { key: "", value: "" };
      for (const [part, item] of fields(value as Buffer)) if (part === 1) header.key = (item as Buffer).toString(); else if (part === 2) header.value = (item as Buffer).toString();
      frame.headers.push(header);
    } else if (id === 8) frame.payload = value as Buffer;
  }
  return frame;
}

/** The part of a WebSocket this needs; `ws` satisfies it. */
export interface Socket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: Uint8Array): void;
  close(): void;
}

const header = (frame: Frame, key: string) => frame.headers.find(item => item.key === key)?.value;

/**
 * Runs one connection until it closes or `signal` aborts; the caller reconnects. Each event is acknowledged only after
 * `onBody` has stored it, so a failure is answered 500 and the platform sends it again.
 */
export function listenLark(options: {
  endpoint(): Promise<{ url: string; pingMs: number }>;
  connect(url: string): Socket;
  onBody(body: Buffer): Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  return (async () => {
    const { url, pingMs } = await options.endpoint();
    const service = Number(new URL(url).searchParams.get("service_id"));
    const socket = options.connect(url);
    const pieces = new Map<string, Buffer[]>();
    let ping: NodeJS.Timeout | undefined;
    let interval = pingMs;
    const pingLoop = () => {
      socket.send(encodeFrame({ SeqID: 0, LogID: 0, service, method: CONTROL, headers: [{ key: "type", value: "ping" }] }));
      ping = setTimeout(pingLoop, interval); ping.unref();
    };
    const handle = async (frame: Frame) => {
      if (frame.method === CONTROL && header(frame, "type") === "pong" && frame.payload?.length) interval = (JSON.parse(frame.payload.toString()).PingInterval ?? interval / 1000) * 1000;
      if (frame.method !== DATA || header(frame, "type") !== "event") return;
      const id = header(frame, "message_id") ?? "";
      const sum = Number(header(frame, "sum") ?? 1);
      const parts = pieces.get(id) ?? [];
      parts[Number(header(frame, "seq") ?? 0)] = frame.payload ?? Buffer.alloc(0);
      pieces.set(id, parts);
      if (parts.filter(Boolean).length < sum) return;
      pieces.delete(id);
      let code = 200;
      const started = Date.now();
      try { await options.onBody(Buffer.concat(parts)); } catch { code = 500; }
      socket.send(encodeFrame({ ...frame, headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }], payload: Buffer.from(JSON.stringify({ code })) }));
    };
    await new Promise<void>(resolve => {
      const end = () => { clearTimeout(ping); resolve(); };
      socket.on("open", pingLoop);
      socket.on("message", (data: Buffer) => { void handle(decodeFrame(Buffer.from(data))).catch(() => undefined); });
      socket.on("close", end);
      socket.on("error", () => socket.close());
      options.signal.addEventListener("abort", () => { socket.close(); end(); }, { once: true });
    });
  })();
}
