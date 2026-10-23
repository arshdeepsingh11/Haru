"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Bell, Camera, Check, CircleAlert, History, LayoutGrid, Plus, RefreshCw, RotateCcw, ShieldQuestion, Sparkles, X } from "lucide-react";
import type { ActionView, MessageView } from "@/lib/ai/agent";
import { CARDS, type CardKey } from "@/lib/dashboard-registry";
import { enablePush } from "@/lib/push-client";
import { ReportCard } from "./ReportCard";
import { AuroraOrb, type OrbState } from "./AuroraOrb";
import { useToast } from "./ui";

const SUGGESTIONS = ["What's my next shift worth?", "When do I get paid next?", "Can I afford $200 this weekend?", "How long until I'm debt-free?"];

/** "[[A|B|C]]" on the last line of a reply becomes tap-to-answer buttons. */
export function splitChoices(text: string): { body: string; choices: string[] } {
  const m = /\n?\s*\[\[([^\]]+)\]\]\s*$/.exec(text);
  if (!m) return { body: text, choices: [] };
  const choices = m[1].split("|").map((c) => c.trim()).filter(Boolean).slice(0, 6);
  return { body: text.slice(0, m.index).trimEnd(), choices };
}

function renderText(text: string) {
  // Minimal, safe formatting: paragraphs, "- " bullets and **bold**. No HTML injection.
  return text.split(/\n{2,}/).map((b, i) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*[-•]\s+/.test(l)))
      return (
        <ul key={i}>
          {lines.map((l, j) => (
            <li key={j}>{bold(l.replace(/^\s*[-•]\s+/, ""))}</li>
          ))}
        </ul>
      );
    return (
      <p key={i}>
        {lines.map((l, j) => (
          <span key={j}>
            {bold(l)}
            {j < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    );
  });
}
function bold(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

type Msg = MessageView & { retryText?: string; cards?: CardKey[] };
type Progress = { id: string; tool: string; status: "running" | "done" | "failed"; summary?: string };

/** What Haru is doing right now, in the user's words. */
const TOOL_LABEL: Record<string, string> = {
  create_job: "Saving your job",
  update_job: "Updating your job",
  create_shift: "Adding a shift",
  create_shifts_batch: "Adding your shifts",
  create_bill: "Adding a bill",
  update_bill: "Updating a bill",
  create_debt: "Adding a debt",
  create_savings_goal: "Creating a goal",
  create_account: "Adding an account",
  set_account_balance: "Updating a balance",
  record_paycheck: "Recording your paycheck",
  record_debt_payment: "Recording a payment",
  create_expense: "Recording spending",
  remember: "Remembering that",
  build_dashboard: "Updating your dashboard",
  get_payoff_plan: "Working out your payoff plan",
  check_affordability: "Checking what you can afford",
  get_paycheck_forecast: "Checking your paycheck",
  update_preferences: "Saving your settings",
  complete_setup: "Finishing setup",
  set_shift_attendance: "Updating your shift",
  checkout_shift: "Logging your hours",
};
const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0];

type StreamEvent = { type: "thinking" } | { type: "tool"; id: string; tool: string; status: Progress["status"]; summary?: string } | { type: "done"; result: TurnPayload } | { type: "error"; error: string };
type TurnPayload = { conversationId: string; user: MessageView; assistant: MessageView; changed: boolean; cardsAdded: CardKey[]; retryable?: boolean; model?: string };

/** Read the server's event stream for one turn; resolves with the final result. */
async function readTurnStream(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void): Promise<TurnPayload> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data:")) continue;
      const e = JSON.parse(chunk.slice(5)) as StreamEvent;
      if (e.type === "done") return e.result;
      if (e.type === "error") throw new Error(e.error);
      onEvent(e);
    }
    if (done) throw new Error("Haru stopped before finishing. Anything already saved is on your dashboard.");
  }
}

export interface CommandCenterProps {
  prefill: string | null;
  onPrefillUsed: () => void;
  onClose?: () => void;
  aiConfigured: boolean;
  /** First run: big orb, Haru opens the conversation. */
  genesis?: boolean;
  setup?: boolean;
  cardCount: number;
  vapidPublicKey: string | null;
  onCardsAdded: (keys: CardKey[]) => void;
  onViewDashboard?: () => void;
  onScan: () => void;
  /** Text to send right away (e.g. after a schedule photo is saved). */
  autoSend?: string | null;
  onAutoSent?: () => void;
}

export function CommandCenter(p: CommandCenterProps) {
  const { prefill, onPrefillUsed, onClose, aiConfigured, genesis = false, setup = false, cardCount, vapidPublicKey, onCardsAdded, onViewDashboard, onScan, autoSend, onAutoSent } = p;
  const router = useRouter();
  const toast = useToast();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversations, setConversations] = useState<{ id: string; title: string | null }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 9000);
    return () => clearTimeout(t);
  }, [busy]);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (id?: string | null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/ai/chat${id ? `?conversationId=${id}` : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Couldn't load your conversation.");
      setConversationId(j.conversation.id);
      setMessages(j.conversation.messages);
      setConversations(j.conversations);
      if (j.model) setModel(j.model);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (prefill != null) {
      setText(prefill);
      onPrefillUsed();
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(prefill.length, prefill.length);
      }, 60);
    }
  }, [prefill, onPrefillUsed]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  // Grow the textarea with its content.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [text]);

  const send = useCallback(
    async (t?: string) => {
      const body = (t ?? text).trim();
      if (!body || busy) return;
      setText("");
      setBusy(true);
      const optimistic: Msg = { id: `tmp-${Date.now()}`, role: "user", content: body, createdAt: new Date().toISOString(), actions: [] };
      setMessages((m) => [...m.filter((x) => !x.retryText), optimistic]);
      try {
        setProgress([]);
        const res = await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, conversationId, stream: true }), signal: AbortSignal.timeout(75_000) });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? "Haru couldn't process that. Nothing was changed.");
        }
        const j = await readTurnStream(res.body, (e) => {
          if (e.type === "tool") setProgress((p) => [...p.filter((x) => x.id !== e.id), { id: e.id, tool: e.tool, status: e.status, summary: e.summary }]);
        });
        setConversationId(j.conversationId);
        const assistant: Msg = { ...j.assistant, cards: j.cardsAdded, retryText: j.retryable ? body : undefined };
        setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), j.retryable ? { ...optimistic, id: j.user.id } : j.user, assistant]);
        if (j.model) setModel(j.model);
        if (j.cardsAdded?.length) onCardsAdded(j.cardsAdded);
        if (j.changed) router.refresh();
        if (!j.retryable) {
          setSpeaking(true);
          setTimeout(() => setSpeaking(false), 1600);
        }
      } catch (e) {
        const msg = (e as Error).message;
        setMessages((m) => [
          ...m,
          { id: `err-${Date.now()}`, role: "assistant", content: /timeout|abort/i.test(msg) ? "Haru took too long to answer. Anything already saved is on your dashboard." : /fetch|network/i.test(msg) ? "Haru couldn't reach the server." : msg, createdAt: new Date().toISOString(), actions: [], error: true, retryText: body },
        ]);
      } finally {
        setBusy(false);
        setProgress([]);
      }
    },
    [text, busy, conversationId, onCardsAdded, router],
  );

  useEffect(() => {
    if (autoSend && !busy && !loading) {
      onAutoSent?.();
      send(autoSend);
    }
  }, [autoSend, busy, loading, send, onAutoSent]);

  async function decide(a: ActionView, decision: "confirm" | "cancel" | "undo") {
    try {
      const res = await fetch(`/api/ai/actions/${a.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "That didn't work.");
      setMessages((m) => [...m.map((msg) => ({ ...msg, actions: msg.actions.map((x) => (x.id === a.id ? j.action : x)) })), j.message]);
      if (decision !== "cancel") router.refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function turnOnPush() {
    const r = await enablePush(vapidPublicKey);
    if (r.ok) {
      toast("Notifications are on for this phone.");
      send("I turned on notifications.");
    } else toast(r.error, "error");
  }

  const orbState: OrbState = busy ? "thinking" : speaking ? "speaking" : "idle";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && !m.error);
  const firstRun = genesis && !loading && messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar: who you're talking to, and what's been built so far. */}
      <header className="flex items-center gap-2 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {onClose && (
          <button className="btn btn-quiet -ml-2 h-10 w-10 p-0 lg:hidden" onClick={onClose} aria-label="Back to dashboard">
            <X size={20} />
          </button>
        )}
        {!firstRun && <AuroraOrb size={34} state={orbState} />}
        <div className="min-w-0 flex-1">
          {!firstRun && (
            <>
              <p className="font-semibold leading-tight">Haru</p>
              <p className="truncate text-xs text-ink-3">{busy ? "Thinking…" : model ?? (setup ? "Setting up" : "Your money coach")}</p>
            </>
          )}
        </div>
        {cardCount > 0 && onViewDashboard && (
          <button className="btn btn-line h-9 min-h-0 px-3 text-xs lg:hidden" onClick={onViewDashboard}>
            <LayoutGrid size={14} /> {cardCount} card{cardCount === 1 ? "" : "s"}
          </button>
        )}
        {!genesis && !setup && (
          <>
            <button className="btn btn-quiet h-10 w-10 p-0" onClick={() => setShowHistory(!showHistory)} aria-label="Past conversations" aria-expanded={showHistory}>
              <History size={18} />
            </button>
            <button
              className="btn btn-quiet h-10 w-10 p-0"
              aria-label="New conversation"
              onClick={() => {
                setConversationId(null);
                setMessages([]);
                setShowHistory(false);
                inputRef.current?.focus();
              }}
            >
              <Plus size={18} />
            </button>
          </>
        )}
      </header>

      {showHistory && (
        <nav aria-label="Past conversations" className="scroll-thin mx-3 mb-2 max-h-60 overflow-y-auto rounded-2xl bg-surface p-2 shadow-lg ring-1 ring-line">
          {conversations.length === 0 && <p className="px-2 py-1 text-sm text-ink-3">No earlier conversations.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`block w-full truncate rounded-xl px-3 py-2 text-left text-sm hover:bg-paper-2 ${c.id === conversationId ? "font-semibold" : ""}`}
              onClick={() => {
                setShowHistory(false);
                load(c.id);
              }}
            >
              {c.title || "Conversation"}
            </button>
          ))}
        </nav>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4" aria-live="polite">
        {!aiConfigured && (
          <p className="mb-3 rounded-2xl bg-amber-soft px-4 py-3 text-sm text-ink">
            The AI isn't configured yet. Add GEMINI_API_KEY to the server environment and restart. Everything else works meanwhile.
          </p>
        )}

        {firstRun && (
          <div className="grid justify-items-center pb-6 pt-12 text-center">
            <AuroraOrb size={168} state={orbState} label="Haru" />
            <h1 className="mt-9 text-[1.7rem] font-semibold leading-tight tracking-tight">Hi, I'm Haru.</h1>
            <p className="mt-2 max-w-[30ch] text-ink-2">Tell me about your work and your goals. I'll build your money dashboard while we talk.</p>
          </div>
        )}

        {loading ? (
          <div className="grid justify-items-center py-16">
            <AuroraOrb size={56} state="thinking" />
          </div>
        ) : loadError ? (
          <div className="text-sm">
            <p className="text-brick">{loadError}</p>
            <button className="btn btn-line mt-2 text-xs" onClick={() => load(conversationId)}>
              Try again
            </button>
          </div>
        ) : (
          <ol className="grid gap-5">
            {firstRun && setup && (
              <li className="msg-in">
                <Bubble>{renderText("First things first. What should I call you?")}</Bubble>
              </li>
            )}
            {messages.length === 0 && !genesis && (
              <li className="grid gap-2">
                <p className="text-sm text-ink-2">Ask anything, or just say what happened today.</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="choice text-sm" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </li>
            )}
            {messages.map((m) => {
              if (m.role === "user")
                return (
                  <li key={m.id} className="msg-in flex justify-end">
                    <p className="max-w-[82%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-ink px-4 py-2.5 text-[0.97rem] text-white">{m.content}</p>
                  </li>
                );
              const { body, choices } = splitChoices(m.content);
              const isLast = m === lastAssistant;
              return (
                <li key={m.id} className="msg-in grid gap-2.5">
                  {m.actions.map((a) => (
                    <ActionCard key={a.id} a={a} onDecide={decide} onScan={onScan} onPush={turnOnPush} onViewDashboard={onViewDashboard} />
                  ))}
                  {m.error ? (
                    <div className="flex items-start gap-2.5 rounded-2xl bg-brick-soft px-4 py-3 text-sm text-ink">
                      <CircleAlert size={17} className="mt-0.5 shrink-0 text-brick" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p>{m.content}</p>
                        {m.retryText && (
                          <button className="btn btn-primary mt-2.5 h-9 min-h-0 px-4 text-xs" disabled={busy} onClick={() => send(m.retryText)}>
                            <RefreshCw size={13} /> Retry
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    body && <Bubble>{renderText(body)}</Bubble>
                  )}
                  {m.cards && m.cards.length > 0 && (
                    <p className="flex w-fit items-start gap-1.5 rounded-2xl px-3 py-1.5 text-xs font-semibold text-iris" style={{ background: "var(--aurora-soft)" }}>
                      <Sparkles size={13} /> Added to your dashboard: {m.cards.map((k) => CARDS[k].title).join(", ")}
                    </p>
                  )}
                  {isLast && !busy && choices.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {choices.map((c) => (
                        <button key={c} className="choice" onClick={() => send(c)}>
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
            {busy && progress.length > 0 && (
              <li className="grid gap-1.5" aria-live="polite">
                {progress.map((p) => (
                  <p key={p.id} className={`msg-in flex items-start gap-2 text-sm ${p.status === "failed" ? "text-brick" : p.status === "done" ? "text-ink-2" : "text-ink-3"}`}>
                    <span className="mt-0.5 shrink-0">{p.status === "done" ? <Check size={14} className="text-iris" /> : p.status === "failed" ? <CircleAlert size={14} /> : <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-iris/30 border-t-iris" />}</span>
                    <span className="min-w-0">{p.status === "running" ? TOOL_LABEL[p.tool] ?? "Working on it" : firstSentence(p.summary ?? TOOL_LABEL[p.tool] ?? "Done")}</span>
                  </p>
                ))}
              </li>
            )}
            {busy && (
              <li className="flex items-center gap-2.5 text-sm text-ink-3">
                <span className="aurora-text font-semibold">{slow ? "Still working on it" : "Haru is thinking"}</span>
                <span className="flex gap-1" aria-hidden>
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-iris [animation-delay:-0.3s]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-lagoon [animation-delay:-0.15s]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-bloom" />
                </span>
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="think-ring rounded-[26px]" data-busy={busy}>
          <div className="glass-strong flex items-end gap-1.5 rounded-[26px] p-1.5">
            <button type="button" className="btn btn-quiet h-10 w-10 shrink-0 p-0" onClick={onScan} aria-label="Scan a photo of your schedule">
              <Camera size={19} />
            </button>
            <label htmlFor="haru-input" className="sr-only">
              Message Haru
            </label>
            <textarea
              id="haru-input"
              ref={inputRef}
              rows={1}
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={firstRun ? "Type your name…" : "Message Haru…"}
              className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 outline-none placeholder:text-ink-3"
            />
            <button className={`btn h-10 w-10 shrink-0 p-0 ${text.trim() ? "btn-aurora" : "bg-paper-2 text-ink-3"}`} disabled={busy || !text.trim()} aria-label="Send">
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Bubble({ children }: { children: React.ReactNode }) {
  return <div className="prose-chat max-w-[92%] text-[0.98rem] leading-relaxed text-ink">{children}</div>;
}

function ActionCard({
  a,
  onDecide,
  onScan,
  onPush,
  onViewDashboard,
}: {
  a: ActionView;
  onDecide: (a: ActionView, d: "confirm" | "cancel" | "undo") => void;
  onScan: () => void;
  onPush: () => void;
  onViewDashboard?: () => void;
}) {
  const [working, setWorking] = useState(false);
  const go = async (d: "confirm" | "cancel" | "undo") => {
    setWorking(true);
    await onDecide(a, d);
    setWorking(false);
  };
  const d = a.display as { kind?: string } | null;
  if (d?.kind === "report") return <ReportCard display={a.display as never} />;
  if (d?.kind === "scan_schedule")
    return (
      <button className="glass flex items-center gap-3 p-3.5 text-left" onClick={onScan}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl coin">
          <Camera size={20} />
        </span>
        <span>
          <span className="block font-semibold">Snap your schedule</span>
          <span className="block text-sm text-ink-2">Haru reads the shifts, you check them</span>
        </span>
      </button>
    );
  if (d?.kind === "enable_push")
    return (
      <button className="glass flex items-center gap-3 p-3.5 text-left" onClick={onPush}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl solid">
          <Bell size={20} />
        </span>
        <span>
          <span className="block font-semibold">Turn on shift reminders</span>
          <span className="block text-sm text-ink-2">1 hour before each shift, and a check-in after</span>
        </span>
      </button>
    );
  if (d?.kind === "setup_done")
    return (
      <div className="hero grid justify-items-start gap-3 p-5">
        <p className="text-lg font-semibold">Your dashboard is ready.</p>
        {onViewDashboard && (
          <button className="btn btn-primary" onClick={onViewDashboard}>
            <LayoutGrid size={16} /> Open my dashboard
          </button>
        )}
      </div>
    );
  if (d?.kind === "dashboard" && a.status === "completed")
    return (
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Sparkles size={13} className="text-iris" /> {a.summary}
        {a.undoable && (
          <button className="underline underline-offset-4" disabled={working} onClick={() => go("undo")}>
            Undo
          </button>
        )}
      </div>
    );

  const label = { pending_confirmation: "Needs your OK", completed: "Saved", failed: "Not saved", cancelled: "Cancelled", undone: "Undone" }[a.status];
  const Icon = a.status === "pending_confirmation" ? ShieldQuestion : a.status === "failed" ? CircleAlert : a.status === "completed" ? Check : X;
  const tone = a.status === "pending_confirmation" ? "text-amber" : a.status === "failed" ? "text-brick" : a.status === "completed" ? "text-iris" : "text-ink-3";

  return (
    <div className="flex gap-3 rounded-2xl bg-surface/80 px-3.5 py-3 text-sm ring-1 ring-line">
      <span className={`mt-0.5 ${tone}`}>
        <Icon size={16} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold ${tone}`}>{label}</p>
        <p className={`mt-0.5 whitespace-pre-line ${a.status === "cancelled" || a.status === "undone" ? "text-ink-3 line-through" : "text-ink"}`}>{a.error ?? a.summary}</p>
        {a.status === "pending_confirmation" && (
          <div className="mt-2.5 flex gap-2">
            <button className="btn btn-primary h-9 min-h-0 px-4 text-xs" disabled={working} onClick={() => go("confirm")}>
              Confirm
            </button>
            <button className="btn btn-quiet h-9 min-h-0 px-3 text-xs" disabled={working} onClick={() => go("cancel")}>
              Cancel
            </button>
          </div>
        )}
        {a.undoable && (
          <button className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-2 underline underline-offset-4" disabled={working} onClick={() => go("undo")}>
            <RotateCcw size={12} aria-hidden /> Undo
          </button>
        )}
      </div>
    </div>
  );
}
