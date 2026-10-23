"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Check, CircleAlert, History, Loader2, Plus, RotateCcw, ShieldQuestion, X } from "lucide-react";
import type { ActionView, MessageView } from "@/lib/ai/agent";
import { ReportCard } from "./ReportCard";
import { useToast } from "./ui";

const SUGGESTIONS = [
  "How much will I earn this month?",
  "When do I get paid next, and how much?",
  "Can I afford to spend $200 this weekend?",
  "Give me my report for this week",
];

function renderText(text: string) {
  // Minimal, safe formatting: paragraphs, "- " bullets and **bold**. No HTML injection.
  const blocks = text.split(/\n{2,}/);
  return blocks.map((b, i) => {
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

export function CommandCenter({ prefill, onPrefillUsed, onClose, aiConfigured }: { prefill: string | null; onPrefillUsed: () => void; onClose?: () => void; aiConfigured: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [conversations, setConversations] = useState<{ id: string; title: string | null }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    if (prefill) {
      setText(prefill);
      onPrefillUsed();
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(prefill.length, prefill.length);
      }, 50);
    }
  }, [prefill, onPrefillUsed]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function send(t?: string) {
    const body = (t ?? text).trim();
    if (!body || busy) return;
    setText("");
    setBusy(true);
    const optimistic: MessageView = { id: `tmp-${Date.now()}`, role: "user", content: body, createdAt: new Date().toISOString(), actions: [] };
    setMessages((m) => [...m, optimistic]);
    try {
      const res = await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, conversationId }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "HARU couldn't process that. Nothing was changed.");
      setConversationId(j.conversationId);
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), j.user, j.assistant]);
      if (j.changed) router.refresh();
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: `err-${Date.now()}`, role: "assistant", content: (e as Error).message.includes("fetch") ? "HARU couldn't reach the server. Nothing was changed." : (e as Error).message, createdAt: new Date().toISOString(), actions: [], error: true },
      ]);
      setText(body);
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Ask HARU</p>
          <p className="truncate text-xs text-ink-3">Log work, money and plans in your own words</p>
        </div>
        <button className="btn btn-quiet px-2" onClick={() => setShowHistory(!showHistory)} aria-label="Conversation history" aria-expanded={showHistory}>
          <History size={17} />
        </button>
        <button
          className="btn btn-quiet px-2"
          aria-label="New conversation"
          onClick={() => {
            setConversationId(null);
            setMessages([]);
            setShowHistory(false);
            inputRef.current?.focus();
          }}
        >
          <Plus size={17} />
        </button>
        {onClose && (
          <button className="btn btn-quiet px-2 lg:hidden" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        )}
      </header>

      {showHistory && (
        <nav aria-label="Past conversations" className="scroll-thin max-h-56 overflow-y-auto border-b border-line px-2 py-2">
          {conversations.length === 0 && <p className="px-2 py-1 text-sm text-ink-3">No earlier conversations.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-paper-2 ${c.id === conversationId ? "font-semibold" : ""}`}
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

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {!aiConfigured && (
          <p className="mb-3 rounded-xl bg-amber-soft px-3 py-2 text-sm text-ink">
            The AI isn't configured on this server yet (ANTHROPIC_API_KEY). Everything else in HARU works; messages will fail honestly until it's set.
          </p>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-ink-3">
            <Loader2 size={15} className="animate-spin" /> Loading your conversation…
          </p>
        ) : loadError ? (
          <div className="text-sm">
            <p className="text-brick">{loadError}</p>
            <button className="btn btn-line mt-2 text-xs" onClick={() => load(conversationId)}>
              Try again
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div>
            <p className="text-ink-2">Try one of these, or just say what happened today.</p>
            <div className="mt-3 grid gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="btn btn-line justify-start text-left text-sm font-normal" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="grid gap-4">
            {messages.map((m) => (
              <li key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[0.95rem] text-paper">{m.content}</p>
                ) : (
                  <div className="grid gap-2">
                    {m.actions.map((a) => (
                      <ActionCard key={a.id} a={a} onDecide={decide} />
                    ))}
                    <div className={`prose-chat max-w-[95%] text-[0.95rem] ${m.error ? "flex gap-2 text-brick" : ""}`}>
                      {m.error && <CircleAlert size={16} className="mt-1 shrink-0" aria-hidden />}
                      <div>{renderText(m.content)}</div>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 text-sm text-ink-3">
                <Loader2 size={15} className="animate-spin" aria-hidden /> HARU is working on it…
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 focus-within:border-[var(--focus)]">
          <label htmlFor="haru-input" className="sr-only">
            Message HARU
          </label>
          <textarea
            id="haru-input"
            ref={inputRef}
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Tell HARU what happened…"
            className="max-h-36 min-h-[2.4rem] flex-1 resize-none bg-transparent px-2 py-2 text-[0.95rem] outline-none placeholder:text-ink-3"
          />
          <button className="btn btn-primary h-9 w-9 shrink-0 p-0" disabled={busy || !text.trim()} aria-label="Send">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={17} />}
          </button>
        </div>
      </form>
    </div>
  );
}

function ActionCard({ a, onDecide }: { a: ActionView; onDecide: (a: ActionView, d: "confirm" | "cancel" | "undo") => void }) {
  const [working, setWorking] = useState(false);
  const go = async (d: "confirm" | "cancel" | "undo") => {
    setWorking(true);
    await onDecide(a, d);
    setWorking(false);
  };
  if (a.display?.kind === "report") return <ReportCard display={a.display as never} />;

  const tone =
    a.status === "pending_confirmation" ? "border-amber bg-amber-soft" : a.status === "failed" ? "border-brick bg-brick-soft" : a.status === "completed" ? "border-moss/40 bg-moss-soft" : "border-line bg-paper-2";
  const label = { pending_confirmation: "Needs your confirmation", completed: "Saved", failed: "Not saved", cancelled: "Cancelled", undone: "Undone" }[a.status];
  const Icon = a.status === "pending_confirmation" ? ShieldQuestion : a.status === "failed" ? CircleAlert : a.status === "completed" ? Check : X;

  return (
    <div className={`rounded-xl border px-3 py-2.5 text-sm ${tone}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
        <Icon size={13} aria-hidden /> {label}
      </p>
      <p className={`mt-0.5 whitespace-pre-line ${a.status === "cancelled" || a.status === "undone" ? "text-ink-3 line-through" : ""}`}>{a.error ?? a.summary}</p>
      {a.status === "pending_confirmation" && (
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary py-1 text-xs" disabled={working} onClick={() => go("confirm")}>
            {working ? <Loader2 size={13} className="animate-spin" /> : null} Confirm
          </button>
          <button className="btn btn-quiet py-1 text-xs" disabled={working} onClick={() => go("cancel")}>
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
  );
}
