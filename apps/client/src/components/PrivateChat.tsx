import { useState, useRef, useEffect } from "react";
import { Send, LogOut, Wifi, WifiOff, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  from: "me" | "peer";
  text: string;
  timestamp: number;
}

export type RtcStatus = "connecting" | "connected" | "disconnected" | "failed";

interface PrivateChatProps {
  peerId: string;
  messages: ChatMessage[];
  rtcStatus: RtcStatus;
  onSend: (text: string) => void;
  onLeave: () => void;
}

// ---------------------------------------------------------------------------
// PrivateChat component – full-screen 2D chat UI
// ---------------------------------------------------------------------------

export function PrivateChat({
  peerId,
  messages,
  rtcStatus,
  onSend,
  onLeave,
}: PrivateChatProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || rtcStatus !== "connected") return;
    onSend(text);
    setDraft("");
  };

  // Connection status badge
  const statusConfig: Record<
    RtcStatus,
    { icon: React.ReactNode; label: string; cls: string }
  > = {
    connecting: {
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      label: "Connecting…",
      cls: "text-amber-600 bg-amber-50",
    },
    connected: {
      icon: <Wifi className="w-3.5 h-3.5" />,
      label: "P2P Connected",
      cls: "text-emerald-600 bg-emerald-50",
    },
    disconnected: {
      icon: <WifiOff className="w-3.5 h-3.5" />,
      label: "Disconnected",
      cls: "text-slate-500 bg-slate-100",
    },
    failed: {
      icon: <WifiOff className="w-3.5 h-3.5" />,
      label: "Connection Failed",
      cls: "text-red-600 bg-red-50",
    },
  };

  const badge = statusConfig[rtcStatus];

  return (
    <div className="w-full h-screen flex flex-col bg-slate-50">
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center">
            <span className="text-blue-600 font-bold text-sm">
              {peerId.slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              Chat with <span className="font-mono">{peerId.slice(0, 8)}</span>
            </h2>
            <div
              className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${badge.cls}`}
            >
              {badge.icon}
              {badge.label}
            </div>
          </div>
        </div>

        <button
          onClick={onLeave}
          className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Leave
        </button>
      </header>

      {/* ── Messages ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {messages.length === 0 && rtcStatus === "connected" && (
          <p className="text-center text-sm text-slate-400 mt-8">
            Connection established — say hello! 👋
          </p>
        )}

        {messages.length === 0 && rtcStatus === "connecting" && (
          <div className="flex flex-col items-center mt-12 gap-2">
            <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
            <p className="text-sm text-slate-400">
              Establishing peer-to-peer connection…
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.from === "me" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.from === "me"
                  ? "bg-blue-600 text-white rounded-br-md"
                  : "bg-white text-slate-800 border border-slate-200 rounded-bl-md shadow-sm"
              }`}
            >
              {msg.text}
              <span
                className={`block text-[10px] mt-1 ${
                  msg.from === "me" ? "text-blue-200" : "text-slate-400"
                }`}
              >
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Input ── */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-4 py-3 bg-white border-t border-slate-200"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            rtcStatus === "connected"
              ? "Type a message…"
              : "Waiting for connection…"
          }
          disabled={rtcStatus !== "connected"}
          className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 placeholder:text-slate-400"
        />
        <button
          type="submit"
          disabled={rtcStatus !== "connected" || !draft.trim()}
          className="p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white transition-colors"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>

      {/* ── Failed overlay ── */}
      {rtcStatus === "failed" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
              <WifiOff className="w-6 h-6 text-red-500" />
            </div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">
              Connection Failed
            </h3>
            <p className="text-sm text-slate-500 mb-5">
              Could not establish a peer-to-peer connection.
            </p>
            <button
              onClick={onLeave}
              className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors"
            >
              Return to World
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
