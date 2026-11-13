import { useState, useRef, useEffect } from "react";
import {
  Send,
  LogOut,
  Wifi,
  WifiOff,
  Loader2,
  Lock,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import type { ChatMessage, RtcStatus } from "@p2p-chat/types";

interface PrivateChatProps {
  peerId: string;
  messages: ChatMessage[];
  rtcStatus: RtcStatus;
  onSend: (text: string) => void;
  onLeave: () => void;
  /** End-to-end encryption state for this chat. */
  e2ee: {
    /** Keys derived and chains usable. */
    ready: boolean;
    /** Both ends proved they hold the same secret. */
    confirmed: boolean;
    /** The local user compared the safety string and said it matches. */
    verified: boolean;
    /** Eight emoji, or null until derived. */
    safety: string[] | null;
    /** Non-null when the handshake or confirmation failed. */
    error: string | null;
    onVerify: () => void;
    onReject: () => void;
  };
}

// ---------------------------------------------------------------------------
// PrivateChat – a card docked over the still-running world.
//
// It used to replace the whole screen, which meant the island vanished the
// moment you started talking and had to be rebuilt when you left. As an
// overlay the scene keeps rendering underneath: on desktop you keep the world
// in view, and on phones it expands to the full viewport.
// ---------------------------------------------------------------------------

export function PrivateChat({
  peerId,
  messages,
  rtcStatus,
  onSend,
  onLeave,
  e2ee,
}: PrivateChatProps) {
  const [draft, setDraft] = useState("");
  const [showSafety, setShowSafety] = useState(false);
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
    if (!text || !canSend) return;
    onSend(text);
    setDraft("");
  };

  /**
   * Sending is gated on all three: a live channel, a cryptographically
   * confirmed session, and the humans having compared the safety string.
   */
  const encrypted = e2ee.ready && e2ee.confirmed && !e2ee.error;
  const canSend = rtcStatus === "connected" && encrypted && e2ee.verified;

  const encryptionLabel = e2ee.error
    ? "encryption unavailable"
    : !e2ee.ready
      ? "securing channel…"
      : !e2ee.confirmed
        ? "confirming keys…"
        : !e2ee.verified
          ? "verify the safety code"
          : "end-to-end encrypted";

  const showPanel =
    showSafety || !!e2ee.error || (e2ee.ready && !e2ee.verified);

  const placeholder = e2ee.error
    ? "encryption unavailable"
    : rtcStatus !== "connected"
      ? "waiting for connection…"
      : !e2ee.ready
        ? "securing channel…"
        : !e2ee.confirmed
          ? "confirming keys…"
          : !e2ee.verified
            ? "verify the safety code to unlock…"
            : "say something…";

  const statusConfig: Record<
    RtcStatus,
    { icon: React.ReactNode; label: string; cls: string }
  > = {
    connecting: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      label: "connecting",
      cls: "bg-mustard text-ink",
    },
    connected: {
      icon: <Wifi className="h-3 w-3" />,
      label: "p2p connected",
      cls: "bg-teal text-ink",
    },
    disconnected: {
      icon: <WifiOff className="h-3 w-3" />,
      label: "disconnected",
      cls: "bg-ink/15 text-ink",
    },
    failed: {
      icon: <WifiOff className="h-3 w-3" />,
      label: "failed",
      cls: "bg-coral text-ink",
    },
  };

  const badge = statusConfig[rtcStatus];

  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-end justify-start md:p-6">
      <div className="pointer-events-auto flex h-dvh w-full flex-col overflow-hidden bg-cream md:h-[520px] md:max-h-[calc(100dvh-3rem)] md:w-[392px] md:rounded-[22px] md:border-2 md:border-ink md:shadow-[6px_6px_0_var(--color-ink)]">
        {/* ── Header ── */}
        <header className="flex items-center justify-between gap-3 border-b-2 border-ink bg-mustard px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-bold tracking-[0.18em] uppercase text-ink/60">
              private channel
            </p>
            <h2 className="truncate text-lg font-black tracking-tight">
              {peerId.slice(0, 8)}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border-2 border-ink px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.1em] uppercase ${badge.cls}`}
            >
              {badge.icon}
              {badge.label}
            </span>

            <button
              onClick={onLeave}
              className="sticker-btn h-9 w-9 bg-cream text-ink"
              aria-label="Leave chat"
              title="Leave chat"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* ── Encryption strip ── */}
        <button
          type="button"
          onClick={() => setShowSafety((open) => !open)}
          className="flex w-full items-center justify-between gap-2 border-b-2 border-ink bg-cream px-4 py-2 text-left"
        >
          <span className="flex items-center gap-2 font-mono text-[9px] font-bold tracking-[0.14em] uppercase text-ink/60">
            {e2ee.error ? (
              <ShieldAlert className="h-3 w-3" />
            ) : encrypted && e2ee.verified ? (
              <ShieldCheck className="h-3 w-3" />
            ) : (
              <Lock className="h-3 w-3" />
            )}
            {encryptionLabel}
          </span>
          <span className="text-base leading-none tracking-[0.08em]">
            {e2ee.safety ? e2ee.safety.join("") : ""}
          </span>
        </button>

        {showPanel && (
          <div
            className={`border-b-2 border-ink px-4 py-3 text-[12px] leading-relaxed font-medium ${
              e2ee.error ? "bg-coral/30 text-ink" : "bg-mustard/40 text-ink/80"
            }`}
          >
            {e2ee.error ? (
              <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{e2ee.error}</span>
              </p>
            ) : e2ee.ready && e2ee.safety && !e2ee.verified ? (
              <div className="space-y-3">
                <p className="font-mono text-[9px] font-bold tracking-[0.14em] uppercase text-ink/60">
                  compare these with your peer
                </p>

                <p
                  className="text-center text-3xl leading-none tracking-[0.12em] select-all"
                  aria-label={e2ee.safety.join(" ")}
                >
                  {e2ee.safety.join("")}
                </p>

                <p>
                  Read them aloud — or type them in the room — and check that
                  you both see the same eight, in the same order. If they
                  differ, someone is sitting between you.
                </p>

                <div className="flex gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={e2ee.onVerify}
                    className="sticker-btn flex-1 bg-teal px-3 py-2 text-[11px] text-ink"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    they match
                  </button>
                  <button
                    type="button"
                    onClick={e2ee.onReject}
                    className="sticker-btn flex-1 bg-coral px-3 py-2 text-[11px] text-ink"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    they differ
                  </button>
                </div>
              </div>
            ) : e2ee.safety ? (
              <>
                Read these eight with{" "}
                <span className="font-mono font-bold">
                  {peerId.slice(0, 8)}
                </span>{" "}
                — on a call, or in the room. You must both see the same eight,
                in the same order. If they differ, someone is sitting between
                you; leave the chat.
              </>
            ) : (
              <>
                Keys are being exchanged. Messages cannot be sent until the
                safety code is confirmed, and are never sent unencrypted.
              </>
            )}
          </div>
        )}

        {/* ── Messages ── */}
        <div
          ref={scrollRef}
          className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3.5"
        >
          {messages.length === 0 && rtcStatus === "connected" && (
            <>
              <div className="flex-1" />
              <p className="text-center text-[13px] font-bold text-ink/60">
                connection established — say hello 👋
              </p>
            </>
          )}

          {messages.length === 0 && rtcStatus === "connecting" && (
            <>
              <div className="flex-1" />
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-coral" />
                <p className="text-[13px] font-bold text-ink/60">
                  shaking hands, peer to peer…
                </p>
              </div>
            </>
          )}

          {messages.map((msg) => {
            const mine = msg.from === "me";
            return (
              <div
                key={msg.id}
                className={`max-w-[84%] rounded-2xl border-2 border-ink px-3.5 py-2 text-[13.5px] leading-relaxed font-medium ${
                  mine
                    ? "self-end rounded-br-[4px] bg-coral text-ink"
                    : "self-start rounded-bl-[4px] bg-white text-ink"
                }`}
              >
                {msg.text}
                <span
                  className={`mt-1 block font-mono text-[9.5px] tracking-wide ${
                    mine ? "text-ink/60" : "text-ink/60"
                  }`}
                >
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            );
          })}
        </div>

        {/* ── Composer ── */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t-2 border-ink bg-white px-2.5 pt-2.5"
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.625rem)",
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            disabled={!canSend}
            className="buoy-input min-w-0 flex-1 px-3.5 py-2.5 text-sm font-medium"
          />
          <button
            type="submit"
            disabled={!canSend || !draft.trim()}
            className="sticker-btn h-10 w-10 shrink-0 bg-coral text-ink"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        {/* ── Failed overlay ── */}
        {rtcStatus === "failed" && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm md:rounded-[20px]">
            <div className="buoy-card w-full max-w-sm p-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border-2 border-ink bg-coral">
                <WifiOff className="h-6 w-6 text-ink" />
              </div>
              <h3 className="text-lg font-black">Connection failed</h3>
              <p className="mt-1 mb-5 text-sm font-medium text-ink/70">
                Could not reach your peer directly.
              </p>
              <button
                onClick={onLeave}
                className="sticker-btn bg-cream px-6 py-2.5 text-sm text-ink"
              >
                Back to the island
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
