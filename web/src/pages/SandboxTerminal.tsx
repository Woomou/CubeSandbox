import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, RefreshCw, SquareTerminal, X } from 'lucide-react';
import { sandboxApi } from '@/api/client';
import { openBrowserPty, type BrowserPty } from '@/lib/cubePty';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function SandboxTerminalPage() {
  const { sandboxID = '' } = useParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const ptyRef = useRef<BrowserPty>();
  const generationRef = useRef(0);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');
  const [error, setError] = useState('');

  const connect = async () => {
    const generation = ++generationRef.current;
    setStatus('connecting');
    setError('');
    await ptyRef.current?.kill().catch(() => undefined);
    ptyRef.current?.disconnect();

    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    terminal.writeln('\x1b[36mConnecting to CubeSandbox PTY…\x1b[0m');
    try {
      const session = await sandboxApi.connect(sandboxID);
      const pty = await openBrowserPty(session, { rows: terminal.rows, cols: terminal.cols });
      if (generation !== generationRef.current) {
        await pty.kill().catch(() => undefined);
        pty.disconnect();
        return;
      }
      ptyRef.current = pty;
      setStatus('connected');
      const reader = pty.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        terminal.write(value);
      }
      if (generation === generationRef.current) {
        setStatus('closed');
        terminal.writeln('\r\n\x1b[33mPTY session closed.\x1b[0m');
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus('error');
      terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace',
      fontSize: 14,
      scrollback: 10_000,
      theme: { background: '#090d12', foreground: '#d8e2ec', cursor: '#34d399' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fit.fit();

    const input = terminal.onData((data) => {
      void ptyRef.current?.send(data).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      });
    });
    const resize = terminal.onResize((size) => void ptyRef.current?.resize(size).catch(() => undefined));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(hostRef.current);
    void connect();

    return () => {
      generationRef.current += 1;
      void ptyRef.current?.kill().catch(() => undefined);
      ptyRef.current?.disconnect();
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
    };
    // The route creates a fresh component when sandboxID changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxID]);

  const closeSession = async () => {
    generationRef.current += 1;
    await ptyRef.current?.kill().catch(() => undefined);
    ptyRef.current?.disconnect();
    ptyRef.current = undefined;
    setStatus('closed');
    terminalRef.current?.writeln('\r\n\x1b[33mPTY session terminated.\x1b[0m');
  };

  const tone = status === 'connected' ? 'text-emerald-400' : status === 'error' ? 'text-red-400' : 'text-amber-300';

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/sandboxes/${encodeURIComponent(sandboxID)}`}><ArrowLeft size={16} /></Link>
        </Button>
        <SquareTerminal size={20} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-lg font-medium">{sandboxID}</h1>
          <p className={`text-xs ${tone}`}>{status}{error ? ` · ${error}` : ''}</p>
        </div>
        <Button variant="outline" onClick={() => void connect()} disabled={status === 'connecting'}>
          <RefreshCw size={14} /> 重新连接
        </Button>
        <Button variant="destructive" onClick={() => void closeSession()} disabled={status !== 'connected'}>
          <X size={14} /> 结束会话
        </Button>
      </div>
      <Card className="min-h-0 flex-1 overflow-hidden bg-[#090d12] p-2">
        <div ref={hostRef} className="h-full min-h-[620px] w-full" />
      </Card>
    </div>
  );
}
