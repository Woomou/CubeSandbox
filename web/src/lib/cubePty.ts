import type { SandboxSessionDto } from '@/api/client';

const ENVD_PORT = 49983;
const CONNECT_END_STREAM = 0x02;
const MAX_FRAME_SIZE = 64 * 1024 * 1024;

export interface PtySize {
  rows: number;
  cols: number;
}

export interface BrowserPty {
  pid: number;
  stream: ReadableStream<Uint8Array>;
  send(data: string): Promise<void>;
  resize(size: PtySize): Promise<void>;
  kill(): Promise<void>;
  disconnect(): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function textToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeFrame(payload: unknown): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(5 + data.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, data.length, false);
  frame.set(data, 5);
  return frame;
}

function headers(session: SandboxSessionDto, streaming: boolean, user?: string): HeadersInit {
  const result: Record<string, string> = {
    'Content-Type': streaming ? 'application/connect+json' : 'application/json',
    'Connect-Protocol-Version': '1',
  };
  if (streaming) result['Connect-Content-Encoding'] = 'identity';
  if (user) result.Authorization = `Basic ${btoa(`${user}:`)}`;
  if (session.envdAccessToken) result['X-Access-Token'] = session.envdAccessToken;
  if (session.trafficAccessToken) {
    result['e2b-traffic-access-token'] = session.trafficAccessToken;
    result['cube-traffic-access-token'] = session.trafficAccessToken;
  }
  return result;
}

function endpoint(sandboxID: string, method: string): string {
  return `/sandbox/${encodeURIComponent(sandboxID)}/${ENVD_PORT}/process.Process/${method}`;
}

async function unary(
  session: SandboxSessionDto,
  method: string,
  payload: unknown,
  keepalive = false,
): Promise<void> {
  const response = await fetch(endpoint(session.sandboxID, method), {
    method: 'POST',
    headers: headers(session, false),
    body: JSON.stringify(payload),
    keepalive,
  });
  if (!response.ok && !(method === 'SendSignal' && response.status === 404)) {
    throw new Error(`${method} failed: HTTP ${response.status}`);
  }
}

interface ParsedEvent {
  start?: { pid?: number };
  data?: { pty?: string };
  end?: { error?: string; exitCode?: number };
}

function parseConnectStream(
  source: ReadableStream<Uint8Array>,
  onStart: (pid: number) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pending = new Uint8Array(0);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (pending.length >= 5) {
          const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(1, false);
          if (size > MAX_FRAME_SIZE) throw new Error(`PTY frame too large: ${size}`);
          if (pending.length >= 5 + size) {
            const flags = pending[0];
            const payload = pending.slice(5, 5 + size);
            pending = pending.slice(5 + size);
            if (flags & CONNECT_END_STREAM) {
              if (payload.length) {
                const trailer = JSON.parse(new TextDecoder().decode(payload));
                if (trailer?.error) throw new Error(trailer.error.message ?? 'PTY stream failed');
              }
              controller.close();
              return;
            }
            const message = JSON.parse(new TextDecoder().decode(payload)) as { event?: ParsedEvent };
            const event = message.event;
            if (event?.start?.pid != null) onStart(Number(event.start.pid));
            if (event?.data?.pty) {
              controller.enqueue(base64ToBytes(event.data.pty));
              return;
            }
            if (event?.end) {
              if (event.end.error) throw new Error(event.end.error);
              controller.close();
              return;
            }
            continue;
          }
        }
        const { done, value } = await reader.read();
        if (done) {
          if (pending.length) controller.error(new Error('PTY stream ended with a partial frame'));
          else controller.close();
          return;
        }
        if (value?.length) {
          const merged = new Uint8Array(pending.length + value.length);
          merged.set(pending);
          merged.set(value, pending.length);
          pending = merged;
        }
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

export async function openBrowserPty(
  session: SandboxSessionDto,
  size: PtySize,
): Promise<BrowserPty> {
  const controller = new AbortController();
  const response = await fetch(endpoint(session.sandboxID, 'Start'), {
    method: 'POST',
    headers: headers(session, true, 'root'),
    body: encodeFrame({
      process: {
        cmd: '/bin/bash',
        args: ['-i', '-l'],
        cwd: '/workspace',
        envs: { TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      },
      pty: { size },
    }) as BodyInit,
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Start PTY failed: HTTP ${response.status}`);
  }

  let pid = 0;
  let resolvePid!: (value: number) => void;
  const pidReady = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const stream = parseConnectStream(response.body, (value) => {
    if (!pid) {
      pid = value;
      resolvePid(value);
    }
  });

  // Start reading one frame so the server's start event supplies the PID before
  // input handlers are exposed. Reconstruct the stream with the first output.
  const reader = stream.getReader();
  const firstRead = reader.read();
  const resolvedPid = await Promise.race([
    pidReady,
    firstRead.then(() => pidReady),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PTY did not return a PID')), 15_000)),
  ]);
  const output = new ReadableStream<Uint8Array>({
    async start(outputController) {
      const first = await firstRead;
      if (!first.done && first.value) outputController.enqueue(first.value);
    },
    async pull(outputController) {
      const next = await reader.read();
      if (next.done) outputController.close();
      else outputController.enqueue(next.value);
    },
    async cancel() {
      await reader.cancel();
    },
  });

  return {
    pid: resolvedPid,
    stream: output,
    send: (data) =>
      unary(session, 'SendInput', {
        process: { pid: resolvedPid },
        input: { pty: textToBase64(data) },
      }),
    resize: (nextSize) =>
      unary(session, 'Update', { process: { pid: resolvedPid }, pty: { size: nextSize } }),
    kill: () =>
      unary(session, 'SendSignal', {
        process: { pid: resolvedPid },
        signal: 'SIGNAL_SIGKILL',
      }, true),
    disconnect: () => controller.abort(),
  };
}
