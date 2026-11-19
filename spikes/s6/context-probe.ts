// Loaded only by isolated S6 CLI fixtures. No prompt or model request is needed.
import fs from 'node:fs';
interface ProbeContext {
  mode: string;
  hasUI: boolean;
  agent: unknown;
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getHeader(): unknown;
  };
  setInterval(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  shutdown(): void;
}
interface ProbeApi {
  on(event: 'session_start', handler: (event: unknown, ctx: ProbeContext) => Promise<void>): void;
}
export default function (pi: ProbeApi) {
  pi.on('session_start', async (_event, ctx) => {
    const file = process.env.S6_PROBE_OUT;
    if (!file) throw new Error('S6_PROBE_OUT required');
    const record = () => fs.appendFileSync(file, JSON.stringify({
      mode: ctx.mode, hasUI: ctx.hasUI, agent: ctx.agent,
      sessionId: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(), header: ctx.sessionManager.getHeader(),
      cwd: ctx.cwd, ticks, at: Date.now(),
    }) + '\n');
    let ticks = 0;
    const timer = ctx.setInterval(() => { ticks++; }, 20);
    await Bun.sleep(110);
    ctx.clearTimer(timer);
    record();
    ctx.shutdown();
  });
}
