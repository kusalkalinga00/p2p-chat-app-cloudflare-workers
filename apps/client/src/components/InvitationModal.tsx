import { Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Outgoing invitation modal – shown after clicking an avatar
// ---------------------------------------------------------------------------

interface OutgoingModalProps {
  targetId: string;
  /** "idle" = confirm screen, "waiting" = sent & awaiting reply, "timeout" = expired */
  status: "idle" | "waiting" | "timeout" | "declined";
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4 animate-in fade-in">
        {/* ── Confirm screen ── */}
        {status === "idle" && (
          <>
            <h3 className="text-lg font-bold text-slate-800 mb-1">
              Send Chat Invitation?
            </h3>
            <p className="text-slate-500 text-sm mb-5">
              Invite user{" "}
              <span className="font-mono font-semibold text-slate-700">
                {targetId.slice(0, 6)}
              </span>{" "}
              to a private chat
            </p>
            <div className="flex gap-3">
              <button
                onClick={onCancel}
                className="flex-1 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onSend}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition-colors"
              >
                Send Request
              </button>
            </div>
          </>
        )}

        {/* ── Waiting for response ── */}
        {status === "waiting" && (
          <div className="flex flex-col items-center py-4">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-3" />
            <p className="text-sm font-medium text-slate-700">
              Waiting for{" "}
              <span className="font-mono">{targetId.slice(0, 6)}</span> to
              respond…
            </p>
            <button
              onClick={onCancel}
              className="mt-4 px-5 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Timed out ── */}
        {status === "timeout" && (
          <div className="flex flex-col items-center py-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center mb-3">
              <span className="text-amber-600 text-lg">⏱</span>
            </div>
            <p className="text-sm font-medium text-slate-700 mb-4">
              User did not respond
            </p>
            <button
              onClick={onCancel}
              className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {/* ── Declined ── */}
        {status === "declined" && (
          <div className="flex flex-col items-center py-4">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center mb-3">
              <span className="text-red-500 text-lg">✕</span>
            </div>
            <p className="text-sm font-medium text-slate-700 mb-4">
              User declined your invitation
            </p>
            <button
              onClick={onCancel}
              className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors"
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4 animate-in fade-in">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
            <span className="text-blue-600 text-lg">💬</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">
              Incoming Chat Request
            </h3>
            <p className="text-slate-500 text-sm">
              From{" "}
              <span className="font-mono font-semibold text-slate-700">
                {fromId.slice(0, 6)}
              </span>
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-600 mb-5">
          This user wants to start a private chat with you.
        </p>

        <div className="flex gap-3">
          <button
            onClick={onDecline}
            className="flex-1 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors"
          >
            Decline
          </button>
          <button
            onClick={onAccept}
            className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
