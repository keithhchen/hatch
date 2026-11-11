/**
 * Discord's Gateway (API v10): the platform pushes events over a WebSocket the bot opens, so no public URL is needed.
 * The state that lets a dropped connection pick up where it stopped lives in `GatewaySession`, owned by the caller.
 */
export type GatewaySession = { id?: string; resumeUrl?: string; /** The last dispatch whose handler finished: a resume replays everything after it. */ seq?: number };

/** The part of a WebSocket this needs; `ws` satisfies it. */
export interface Socket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(code?: number): void;
}

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT (privileged: the app must turn it on). Button presses need no intent. */
export const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const DISPATCH = 0, HEARTBEAT = 1, IDENTIFY = 2, RESUME = 6, RECONNECT = 7, INVALID_SESSION = 9, HELLO = 10, HEARTBEAT_ACK = 11;
/** Closes that no reconnect fixes: the token, the intents or the sharding are wrong. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Closes after which the session can no longer be resumed. */
const NOT_RESUMABLE = new Set([4007, 4009]);
/** Ours: a close Discord lets us resume. */
const RESUMABLE = 4000;

/**
 * Runs one connection until it closes or `signal` aborts; the caller reconnects, and the session resumes it. A dispatch moves
 * `session.seq` only after `onDispatch` has stored it, and one that fails closes the connection, so the resume brings it again.
 */
export function listenDiscord(options: {
  token: string;
  session: GatewaySession;
  connect(url: string): Socket;
  onDispatch(type: string, data: any): Promise<void>;
  signal: AbortSignal;
  random?: () => number;
}): Promise<void> {
  const { session, token } = options;
  return new Promise<void>((resolve, reject) => {
    const socket = options.connect(session.id && session.resumeUrl ? `${session.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL);
    const send = (op: number, d: unknown) => socket.send(JSON.stringify({ op, d }));
    let first: NodeJS.Timeout | undefined;
    let beat: NodeJS.Timeout | undefined;
    let acked = true;
    let failed = false;
    let queue = Promise.resolve();
    const end = (error?: Error) => { clearTimeout(first); clearInterval(beat); if (error) reject(error); else resolve(); };
    // A heartbeat nobody answered means the connection is dead without having closed.
    const heartbeat = () => { if (!acked) { socket.close(RESUMABLE); return; } acked = false; send(HEARTBEAT, session.seq ?? null); };
    const dispatch = async (type: string, data: any, seq: number | undefined) => {
      if (type === "READY") { session.id = data.session_id; session.resumeUrl = data.resume_gateway_url; }
      else await options.onDispatch(type, data);
      if (seq !== undefined) session.seq = seq;
    };
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { op: number; d: any; s?: number | null; t?: string };
      if (frame.op === HELLO) {
        first = setTimeout(() => { heartbeat(); beat = setInterval(heartbeat, frame.d.heartbeat_interval); beat.unref(); }, frame.d.heartbeat_interval * (options.random ?? Math.random)());
        first.unref();
        if (session.id) send(RESUME, { token, session_id: session.id, seq: session.seq ?? 0 });
        else send(IDENTIFY, { token, intents: INTENTS, properties: { os: "linux", browser: "hatch", device: "hatch" } });
      } else if (frame.op === HEARTBEAT_ACK) acked = true;
      else if (frame.op === HEARTBEAT) send(HEARTBEAT, session.seq ?? null);
      else if (frame.op === RECONNECT) socket.close(RESUMABLE);
      else if (frame.op === INVALID_SESSION) { if (!frame.d) { session.id = undefined; session.seq = undefined; } socket.close(RESUMABLE); }
      else if (frame.op === DISPATCH && frame.t) {
        // In order, and none after one that failed: its resume must bring that one first.
        queue = queue.then(() => failed ? undefined : dispatch(frame.t!, frame.d, frame.s ?? undefined)).catch(() => { failed = true; socket.close(RESUMABLE); });
      }
    });
    socket.on("close", (code?: number) => {
      if (code !== undefined && NOT_RESUMABLE.has(code)) { session.id = undefined; session.seq = undefined; }
      end(code !== undefined && FATAL.has(code) ? new Error(`Discord Gateway closed with ${code}: check the bot token and that the Message Content intent is enabled`) : undefined);
    });
    socket.on("error", () => socket.close(RESUMABLE));
    options.signal.addEventListener("abort", () => { socket.close(RESUMABLE); end(); }, { once: true });
  });
}
