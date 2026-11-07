import { Loader2 } from "lucide-react";
import type { OutgoingStatus } from "@p2p-chat/types";

// ---------------------------------------------------------------------------
// Invitation modals, Buoy style: a sticker card on cream paper, ink outline,
// hard offset shadow, with the destructive/hopeful actions colour-coded
// (coral = send, teal = accept).
// ---------------------------------------------------------------------------

interface OutgoingModalProps {
  targetId: string;
  /** "idle" = confirm screen, "waiting" = sent & awaiting reply, "timeout" = expired */
  status: OutgoingStatus;
  onSend: () => void;
  onCancel: () => void;
}

export function OutgoingInvitationModal({
  targetId,
  status,
  onSend,
  onCancel,
}: OutgoingModalProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
      <div className="buoy-card w-full max-w-sm p-6">
        {/* ── Confirm screen ── */}
        {status === "idle" && (
          <>
            <h3 className="text-xl font-black tracking-tight">
              Send an invitation?
            </h3>
            <p className="mt-1.5 mb-5 text-sm font-medium text-ink/70">
              Invite{" "}
              <span className="font-mono font-bold text-ink">
                {targetId.slice(0, 6)}
              </span>{" "}
              to a private chat.
            </p>
            <div className="flex gap-2.5">
              <button
                onClick={onCancel}
                className="sticker-btn flex-1 bg-cream px-4 py-2.5 text-sm text-ink"
              >
                Cancel
              </button>
              <button
                onClick={onSend}
                className="sticker-btn flex-1 bg-coral px-4 py-2.5 text-sm text-cream"
              >
                Send request
              </button>
            </div>
          </>
        )}

        {/* ── Waiting for response ── */}
        {status === "waiting" && (
          <div className="flex flex-col items-center py-2">
            <Loader2 className="mb-3 h-8 w-8 animate-spin text-coral" />
            <p className="text-sm font-bold">
              Waiting for{" "}
              <span className="font-mono">{targetId.slice(0, 6)}</span>…
            </p>
            <button
              onClick={onCancel}
              className="sticker-btn mt-4 bg-cream px-5 py-2 text-sm text-ink"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Timed out ── */}
        {status === "timeout" && (
          <div className="flex flex-col items-center py-2">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border-2 border-ink bg-mustard text-lg">
              ⏱
            </div>
            <p className="mb-4 text-sm font-bold">No answer yet.</p>
            <button
              onClick={onCancel}
              className="sticker-btn bg-cream px-6 py-2.5 text-sm text-ink"
            >
              Close
            </button>
          </div>
        )}

        {/* ── Declined ── */}
        {status === "declined" && (
          <div className="flex flex-col items-center py-2">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border-2 border-ink bg-coral text-lg text-ink">
              ✕
            </div>
            <p className="mb-4 text-sm font-bold">They declined.</p>
            <button
              onClick={onCancel}
              className="sticker-btn bg-cream px-6 py-2.5 text-sm text-ink"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incoming invitation modal – shown when someone requests to chat with us
// ---------------------------------------------------------------------------

interface IncomingModalProps {
  fromId: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingInvitationModal({
  fromId,
  onAccept,
  onDecline,
}: IncomingModalProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
      <div className="buoy-card w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-mustard text-lg">
            💬
          </div>
          <div className="min-w-0">
            <h3 className="text-xl leading-tight font-black tracking-tight">
              Chat request
            </h3>
            <p className="text-sm font-medium text-ink/70">
              from{" "}
              <span className="font-mono font-bold text-ink">
                {fromId.slice(0, 6)}
              </span>
            </p>
          </div>
        </div>

        <p className="mb-5 text-sm font-medium text-ink/70">
          They want to open a direct, peer-to-peer chat with you.
        </p>

        <div className="flex gap-2.5">
          <button
            onClick={onDecline}
            className="sticker-btn flex-1 bg-cream px-4 py-2.5 text-sm text-ink"
          >
            Decline
          </button>
          <button
            onClick={onAccept}
            className="sticker-btn flex-1 bg-teal px-4 py-2.5 text-sm text-ink"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
