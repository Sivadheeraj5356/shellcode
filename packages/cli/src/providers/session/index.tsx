import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  runAgent, loadConfig, saveConfig, providerStatus, harnessStatus, DEFAULT_CONFIG,
  saveSession, loadSession, newSessionId, type SessionData,
  type AgentEvent, type Config, type ModelInfo, type Policy, type HarnessStatus, type ProviderStatus, type ChatMessage,
} from "@shellcode/core";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "route"; tier: string; reasons: string[]; model?: string }
  | { kind: "tool"; name: string; summary: string; error?: boolean }
  | { kind: "note"; text: string; error?: boolean };

type SessionValue = {
  entries: Entry[];
  live: string;
  running: boolean;
  cfg: Config;
  providers: ProviderStatus[];
  harnesses: HarnessStatus[];
  models: ModelInfo[];
  lastModel?: string;
  lastTier?: string;
  send: (text: string) => void;
  stop: () => void;
  newChat: () => void;
  resume: (id: string) => Promise<boolean>;
  update: (patch: Partial<Config>) => void;
  refresh: () => void;
  approval: { what: string; resolve: (ok: boolean) => void } | null;
};

const Ctx = createContext<SessionValue | null>(null);
export function useSession() { const v = useContext(Ctx); if (!v) throw new Error("useSession outside SessionProvider"); return v; }

function summarize(name: string, input: any): string {
  if (name === "bash") return String(input.command ?? "").split("\n")[0]!.slice(0, 80);
  return String(input.path ?? input.pattern ?? "").slice(0, 80);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState("");
  const [running, setRunning] = useState(false);
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const [lastModel, setLastModel] = useState<string>();
  const [lastTier, setLastTier] = useState<string>();
  const [approval, setApproval] = useState<SessionValue["approval"]>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const idRef = useRef(newSessionId());
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  const refresh = useCallback(() => {
    (async () => {
      const c = await loadConfig();
      setCfg(c);
      const ps = await providerStatus(c);
      setProviders(ps);
      setHarnesses(await harnessStatus(process.env as any, ps.some((p) => p.models.length > 0)));
    })();
  }, []);
  useEffect(refresh, [refresh]);

  const update = useCallback((patch: Partial<Config>) => {
    const next = { ...cfgRef.current, ...patch };
    setCfg(next);
    void saveConfig(next);
  }, []);

  const send = useCallback((text: string) => {
    if (running) return;
    setEntries((e) => [...e, { kind: "user", text }]);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let buf = "";
    const flush = () => { if (buf.trim()) { const t = buf.trim(); setEntries((e) => [...e, { kind: "assistant", text: t }]); historyRef.current.push({ role: "assistant", content: t }); } buf = ""; setLive(""); };
    (async () => {
      try {
        const models = providers.flatMap((p) => p.models);
        for await (const ev of runAgent({ prompt: text, cwd: process.cwd(), history: historyRef.current.slice(-20), signal: ac.signal }, {
          cfg: cfgRef.current, models,
          approve: (what) => new Promise<boolean>((resolve) => setApproval({ what, resolve: (ok) => { setApproval(null); resolve(ok); } })),
        })) handle(ev);
        flush();
        historyRef.current.push({ role: "user", content: text });
        persist(text);
      } catch (e: any) {
        flush();
        setEntries((x) => [...x, { kind: "note", text: ac.signal.aborted ? "stopped" : e.message, error: !ac.signal.aborted }]);
      } finally { setRunning(false); abortRef.current = null; }
    })();
    function persist(first: string) {
      setTimeout(() => {
        const data: SessionData = { id: idRef.current, cwd: process.cwd(), title: (entriesRef.current.find((e) => e.kind === "user") as any)?.text?.slice(0, 60) ?? first.slice(0, 60), updatedAt: "", history: historyRef.current, entries: entriesRef.current };
        void saveSession(data).catch(() => {});
      }, 50);
    }
    function handle(ev: AgentEvent) {
      switch (ev.type) {
        case "route": {
          const m = ev.decision.chain[0];
          setLastTier(ev.decision.tier);
          if (m) setLastModel(`${m.provider}/${m.id}`);
          setEntries((x) => [...x, { kind: "route", tier: ev.decision.tier, reasons: ev.decision.reasons, model: m ? `${m.provider}/${m.id}` : undefined }]);
          break;
        }
        case "text": buf += ev.text; setLive(buf); break;
        case "tool": flush(); setEntries((x) => [...x, { kind: "tool", name: ev.name, summary: summarize(ev.name, ev.input), error: ev.error }]); break;
        case "fallback": setLastModel(ev.to); setEntries((x) => [...x, { kind: "note", text: `fell back ${ev.from} -> ${ev.to} (${ev.reason})` }]); break;
        case "error": flush(); setEntries((x) => [...x, { kind: "note", text: ev.message, error: true }]); break;
        default: break;
      }
    }
  }, [running, providers]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const newChat = useCallback(() => { historyRef.current = []; idRef.current = newSessionId(); setEntries([]); setLive(""); }, []);
  const resume = useCallback(async (id: string) => {
    const s = await loadSession(id);
    if (!s) return false;
    idRef.current = s.id; historyRef.current = s.history; setEntries(s.entries as Entry[]);
    return true;
  }, []);

  return (
    <Ctx.Provider value={{ entries, live, running, resume, cfg, providers, harnesses, models: providers.flatMap((p) => p.models), lastModel, lastTier, send, stop, newChat, update, refresh, approval }}>
      {children}
    </Ctx.Provider>
  );
}
