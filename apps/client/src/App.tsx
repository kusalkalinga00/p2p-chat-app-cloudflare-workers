import { useState, useRef, useEffect, useCallback } from "react";
import { IslandWorld } from "./components/IslandWorld";
import { PrivateChat } from "./components/PrivateChat";
import {
  OutgoingInvitationModal,
  IncomingInvitationModal,
} from "./components/InvitationModal";
import { WorldBot } from "./components/WorldBot";
import { Wifi, WifiOff, Loader2, Users } from "lucide-react";
import type {
  ChatMessage,
  ClientMessage,
  IceCandidate,
  OutgoingStatus,
  RtcStatus,
  ServerMessage,
  SessionDescription,
  User,
  View,
} from "@p2p-chat/types";
import {
  INVITATION_TIMEOUT_MS,
  STUN_SERVERS,
  WORLD_WSS_URL,
} from "./lib/constants";
import { randomColor, randomPosition } from "./lib/utils";

/** Close code the server uses when a newer connection claims our ID. */
const CLOSE_REPLACED = 4001;

const MAX_RECONNECT_DELAY_MS = 8_000;

function App() {
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);

  const [view, setView] = useState<View>("world");

  const [outgoingTarget, setOutgoingTarget] = useState<string | null>(null);
  const [outgoingStatus, setOutgoingStatus] = useState<OutgoingStatus>("idle");
  const [incomingRequest, setIncomingRequest] = useState<string | null>(null);

  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>("disconnected");
  const [isBotClosed, setIsBotClosed] = useState(false);
  const [userChangeMessage, setUserChangeMessage] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  // Identity is generated once per page load and never read during render
  // from a mutable ref.
  const [identity] = useState(() => ({
    id: crypto.randomUUID(),
    color: randomColor(),
    position: randomPosition(),
  }));

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectingRef = useRef(false);
  const joinSoundRef = useRef<HTMLAudioElement | null>(null);
  const inviteSoundRef = useRef<HTMLAudioElement | null>(null);
  const messageSoundRef = useRef<HTMLAudioElement | null>(null);
  const lastMessageSoundAtRef = useRef(0);
  const userChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  /** ICE candidates that arrived before the remote description was set. */
  const pendingCandidatesRef = useRef<IceCandidate[]>([]);

  const shouldReconnectRef = useRef(true);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const viewRef = useRef<View>("world");

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const playSound = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch((err) => {
      console.warn("[Sound] Playback blocked or failed:", err);
    });
  }, []);

  useEffect(() => {
    joinSoundRef.current = new Audio("/sounds/when_users_join.mp3");
    inviteSoundRef.current = new Audio("/sounds/chat_invitation came.mp3");
    messageSoundRef.current = new Audio("/sounds/message_recieve.mp3");

    const allSounds = [
      joinSoundRef.current,
      inviteSoundRef.current,
      messageSoundRef.current,
    ];

    for (const sound of allSounds) {
      if (!sound) continue;
      sound.preload = "auto";
      sound.load();
    }
  }, []);

  useEffect(() => {
    return () => {
      if (userChangeTimeoutRef.current)
        clearTimeout(userChangeTimeoutRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  /**
   * Flash a transient world notice. Driven by the actual join/leave event
   * rather than by diffing the user count in an effect.
   */
  const showUserChange = useCallback((message: string) => {
    if (viewRef.current !== "world") return;

    setUserChangeMessage(message);
    if (userChangeTimeoutRef.current)
      clearTimeout(userChangeTimeoutRef.current);
    userChangeTimeoutRef.current = setTimeout(() => {
      setUserChangeMessage(null);
    }, 2500);
  }, []);

  const wsSend = useCallback((payload: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  // ────────────────────────────────────────────────────────────────
  // WebRTC helpers
  // ────────────────────────────────────────────────────────────────

  /** Tear down the RTCPeerConnection & DataChannel cleanly. */
  const cleanupRtc = useCallback(() => {
    pendingCandidatesRef.current = [];
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setRtcStatus("disconnected");
  }, []);

  /**
   * Apply candidates that arrived before `setRemoteDescription`.
   * Dropping them is the classic cause of "connects for me, not for you".
   */
  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("[WebRTC] Failed to add queued ICE candidate:", err);
      }
    }
  }, []);

  /** Wire up DataChannel events (shared by offerer & answerer). */
  const setupDataChannel = useCallback(
    (dc: RTCDataChannel) => {
      dcRef.current = dc;

      dc.onopen = () => {
        console.log("[WebRTC] DataChannel open");
        setRtcStatus("connected");
      };

      dc.onclose = () => {
        console.log("[WebRTC] DataChannel closed");
        setRtcStatus("disconnected");
      };

      dc.onmessage = (e) => {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            from: "peer",
            text: String(e.data),
            timestamp: Date.now(),
          },
        ]);

        const now = Date.now();
        if (now - lastMessageSoundAtRef.current > 250) {
          playSound(messageSoundRef.current);
          lastMessageSoundAtRef.current = now;
        }
      };
    },
    [playSound],
  );

  /** Create a new peer connection and hook it up. */
  const createPeerConnection = useCallback(
    (targetId: string) => {
      // Candidates can arrive before the offer does. Hold on to them:
      // cleanupRtc() below resets the queue, which would drop them.
      const early = pendingCandidatesRef.current;

      cleanupRtc();
      pendingCandidatesRef.current = early;

      const pc = new RTCPeerConnection(STUN_SERVERS);
      pcRef.current = pc;
      setRtcStatus("connecting");

      // Relay ICE candidates via the World DO
      pc.onicecandidate = (e) => {
        const json = e.candidate?.toJSON();
        // `candidate` is optional in the DOM type but required by us.
        if (json?.candidate) {
          wsSend({
            type: "rtc-ice-candidate",
            target: targetId,
            payload: { ...json, candidate: json.candidate },
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("[WebRTC] Connection state:", pc.connectionState);
        if (pc.connectionState === "failed") {
          setRtcStatus("failed");
        }
      };

      // Answerer receives the channel via this event
      pc.ondatachannel = (e) => {
        console.log("[WebRTC] Received remote DataChannel");
        setupDataChannel(e.channel);
      };

      return pc;
    },
    [cleanupRtc, wsSend, setupDataChannel],
  );

  /** Offerer: create offer and send it. */
  const startOffer = useCallback(
    async (targetId: string) => {
      const pc = createPeerConnection(targetId);

      // Offerer creates the DataChannel
      const dc = pc.createDataChannel("chat");
      setupDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        setRtcStatus("failed");
        return;
      }

      wsSend({
        type: "rtc-offer",
        target: targetId,
        payload: { type: "offer", sdp } satisfies SessionDescription,
      });

      console.log("[WebRTC] Sent offer to", targetId);
    },
    [createPeerConnection, setupDataChannel, wsSend],
  );

  /** Answerer: handle the incoming offer, create answer. */
  const handleOffer = useCallback(
    async (fromId: string, offer: SessionDescription) => {
      const pc = createPeerConnection(fromId);

      await pc.setRemoteDescription(offer);
      // Candidates that raced ahead of the offer can be applied now.
      await flushPendingCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        setRtcStatus("failed");
        return;
      }

      wsSend({
        type: "rtc-answer",
        target: fromId,
        payload: { type: "answer", sdp } satisfies SessionDescription,
      });

      console.log("[WebRTC] Sent answer to", fromId);
    },
    [createPeerConnection, flushPendingCandidates, wsSend],
  );

  /** Offerer: handle the returned answer. */
  const handleAnswer = useCallback(
    async (answer: SessionDescription) => {
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(answer);
      await flushPendingCandidates(pc);
      console.log("[WebRTC] Remote description set (answer)");
    },
    [flushPendingCandidates],
  );

  /** Both sides: add ICE candidate, queueing if the description is missing. */
  const handleIceCandidate = useCallback(
    async (candidate: IceCandidate) => {
      const pc = pcRef.current;
      if (!pc || !pc.remoteDescription) {
        // No peer connection (yet) or no remote description to attach to —
        // apply it once the offer/answer has been processed.
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("[WebRTC] Failed to add ICE candidate:", err);
      }
    },
    [],
  );

  // ────────────────────────────────────────────────────────────────
  // Transition: enter private chat view
  // ────────────────────────────────────────────────────────────────

  const enterChat = useCallback(
    (peerId: string, offerer: boolean) => {
      // Clear invitation UI
      setOutgoingTarget(null);
      setOutgoingStatus("idle");
      setIncomingRequest(null);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      // The server marks both users unavailable when it pairs them, so
      // there is nothing to announce here.

      setChatTarget(peerId);
      setMessages([]);
      setView("chat");

      // The offerer kicks off WebRTC negotiations
      if (offerer) {
        void startOffer(peerId);
      }
      // (The answerer waits for the rtc-offer message, handled in handleMessage)
    },
    [startOffer],
  );

  // ────────────────────────────────────────────────────────────────
  // Transition: leave chat and return to world
  // ────────────────────────────────────────────────────────────────

  const leaveChat = useCallback(() => {
    cleanupRtc();
    setChatTarget(null);
    setMessages([]);
    setView("world");

    // Tell the server to release the pairing (and the peer) so we become
    // available again and nobody is left talking to a closed channel.
    wsSend({ type: "chat-leave" });
  }, [cleanupRtc, wsSend]);

  // ────────────────────────────────────────────────────────────────
  // WebSocket message handler
  // ────────────────────────────────────────────────────────────────

  const handleMessage = useCallback(
    (data: ServerMessage) => {
      switch (data.type) {
        // ── World presence ──
        case "world-state":
          setUsers(data.users);
          reconnectingRef.current = false;
          break;

        case "user-joined":
          setUsers((prev) => [
            ...prev.filter((u) => u.id !== data.user.id),
            data.user,
          ]);
          if (!reconnectingRef.current) {
            playSound(joinSoundRef.current);
            showUserChange("A new user joined the island.");
          }
          break;

        case "user-left":
          setUsers((prev) => prev.filter((u) => u.id !== data.id));
          if (!reconnectingRef.current) {
            showUserChange("A user left the island.");
          }
          break;

        // ── World availability ──
        case "availability-changed":
          setUsers((prev) =>
            prev.map((u) =>
              u.id === data.id ? { ...u, available: data.available } : u,
            ),
          );
          break;

        // ── Chat invitation flow ──
        case "chat-request":
          // Ignore if already in a chat or handling another request
          if (view === "chat" || incomingRequest) break;
          setIncomingRequest(data.from);
          playSound(inviteSoundRef.current);
          break;

        case "chat-cancelled":
          setIncomingRequest((current) =>
            current === data.from ? null : current,
          );
          break;

        case "chat-response":
          if (timeoutRef.current) clearTimeout(timeoutRef.current);

          if (data.accept) {
            // Both users transition to chat; the sender is the offerer
            enterChat(data.from, true);
          } else {
            setOutgoingStatus("declined");
          }
          break;

        // ── WebRTC signaling relay ──
        case "rtc-offer":
          void handleOffer(data.from, data.payload);
          break;

        case "rtc-answer":
          void handleAnswer(data.payload);
          break;

        case "rtc-ice-candidate":
          void handleIceCandidate(data.payload);
          break;

        case "peer-left":
          if (chatTarget === data.id) {
            cleanupRtc();
            setChatTarget(null);
            setMessages([]);
            setView("world");
            setNotice("Your chat partner disconnected.");
            wsSend({ type: "chat-leave" });
          }
          break;

        case "error":
          console.warn(`[server] ${data.code}: ${data.message}`);
          setNotice(data.message);
          break;
      }
    },
    [
      view,
      incomingRequest,
      chatTarget,
      enterChat,
      handleOffer,
      handleAnswer,
      handleIceCandidate,
      cleanupRtc,
      playSound,
      showUserChange,
      wsSend,
    ],
  );

  // Keep handleMessage ref up-to-date for the WebSocket onmessage
  const handleMessageRef = useRef(handleMessage);
  useEffect(() => {
    handleMessageRef.current = handleMessage;
  }, [handleMessage]);

  // ────────────────────────────────────────────────────────────────
  // Connect to world WebSocket
  // ────────────────────────────────────────────────────────────────

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const existing = wsRef.current;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setIsConnecting(true);
    const ws = new WebSocket(`${WORLD_WSS_URL}/world/world?id=${identity.id}`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
      setIsConnecting(false);

      ws.send(
        JSON.stringify({
          type: "spawn",
          x: identity.position[0],
          y: identity.position[1],
          z: identity.position[2],
          color: identity.color,
          // Coming back mid-chat: stay hidden from invites.
          available: viewRef.current === "world",
        } satisfies ClientMessage),
      );
    };

    ws.onmessage = (event) => {
      let data: ServerMessage;
      try {
        data = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        console.warn("[ws] Ignoring non-JSON frame");
        return;
      }
      handleMessageRef.current(data);
    };

    ws.onclose = (event) => {
      setConnected(false);
      setIsConnecting(false);
      setUsers([]);
      setUserChangeMessage(null);
      reconnectingRef.current = true;
      wsRef.current = null;

      // Another tab claimed our ID — do not fight it.
      if (event.code === CLOSE_REPLACED) return;
      if (!shouldReconnectRef.current) return;

      const delay = Math.min(
        500 * 2 ** attemptRef.current,
        MAX_RECONNECT_DELAY_MS,
      );
      attemptRef.current += 1;

      reconnectTimerRef.current = setTimeout(() => {
        if (shouldReconnectRef.current) connectRef.current();
      }, delay);
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setIsConnecting(false);
    };
  }, [identity]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Close the socket when the component unmounts (and stop retrying).
  useEffect(() => {
    shouldReconnectRef.current = true;
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  // ────────────────────────────────────────────────────────────────
  // Invitation actions
  // ────────────────────────────────────────────────────────────────

  /** User clicked an avatar → open outgoing modal (only if they're available). */
  const handleAvatarClick = useCallback(
    (targetId: string) => {
      const target = users.find((u) => u.id === targetId);
      if (target && !target.available) return; // busy / in chat
      setOutgoingTarget(targetId);
      setOutgoingStatus("idle");
    },
    [users],
  );

  /** User confirmed "Send Request" in the outgoing modal. */
  const sendInvitation = useCallback(() => {
    if (!outgoingTarget) return;
    const target = outgoingTarget;
    wsSend({ type: "chat-request", target });
    setOutgoingStatus("waiting");

    // Start the invitation timeout; withdraw the request when it fires so
    // the other side's modal does not linger.
    timeoutRef.current = setTimeout(() => {
      setOutgoingStatus("timeout");
      wsSend({ type: "chat-cancel", target });
    }, INVITATION_TIMEOUT_MS);
  }, [outgoingTarget, wsSend]);

  /** Dismiss outgoing modal (cancel / close after timeout). */
  const cancelOutgoing = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (outgoingTarget && outgoingStatus === "waiting") {
      wsSend({ type: "chat-cancel", target: outgoingTarget });
    }
    setOutgoingTarget(null);
    setOutgoingStatus("idle");
  }, [outgoingTarget, outgoingStatus, wsSend]);

  /** User accepted an incoming request. */
  const acceptIncoming = useCallback(() => {
    if (!incomingRequest) return;
    const roomId = [identity.id, incomingRequest].sort().join("-");
    wsSend({
      type: "chat-response",
      target: incomingRequest,
      accept: true,
      roomId,
    });
    // Answerer enters chat (will receive rtc-offer shortly)
    enterChat(incomingRequest, false);
  }, [identity.id, incomingRequest, wsSend, enterChat]);

  /** User declined an incoming request. */
  const declineIncoming = useCallback(() => {
    if (!incomingRequest) return;
    wsSend({
      type: "chat-response",
      target: incomingRequest,
      accept: false,
      roomId: "",
    });
    setIncomingRequest(null);
  }, [incomingRequest, wsSend]);

  /** Send a chat message over the DataChannel. */
  const sendChatMessage = useCallback((text: string) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(text);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), from: "me", text, timestamp: Date.now() },
    ]);
  }, []);

  const worldBotMessage = notice
    ? notice
    : incomingRequest
      ? "Someone invited you to chat. Accept or decline."
      : outgoingStatus === "waiting"
        ? "Invitation sent. Waiting for response..."
        : outgoingStatus === "declined"
          ? "Invitation declined. Try inviting someone else."
          : outgoingStatus === "timeout"
            ? "No response yet. You can try again."
            : (userChangeMessage ??
              "Click on another avatar to start a private chat.");

  const showWorldBot = view === "world" && connected && !isBotClosed;

  if (!connected && view === "world") {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 w-full max-w-md text-center">
          <h1 className="text-2xl font-bold text-slate-800 mb-6">
            Island Chat
          </h1>

          <div className="flex items-center justify-center gap-3 mb-6 py-4 bg-slate-50 rounded-xl">
            {isConnecting ? (
              <>
                <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                <span className="font-medium text-blue-700">Connecting…</span>
              </>
            ) : (
              <>
                <WifiOff className="w-5 h-5 text-slate-400" />
                <span className="font-medium text-slate-500">Disconnected</span>
              </>
            )}
          </div>

          <button
            onClick={connect}
            disabled={isConnecting}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-xl font-semibold transition-all"
          >
            {isConnecting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Wifi className="w-5 h-5" />
            )}
            {isConnecting ? "Connecting…" : "Enter World"}
          </button>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Render: Private Chat view
  // ────────────────────────────────────────────────────────────────

  if (view === "chat" && chatTarget) {
    return (
      <PrivateChat
        peerId={chatTarget}
        messages={messages}
        rtcStatus={rtcStatus}
        onSend={sendChatMessage}
        onLeave={leaveChat}
      />
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Render: 3D World view
  // ────────────────────────────────────────────────────────────────

  return (
    <div className="relative w-full h-screen">
      {/* 3D World */}
      <IslandWorld
        users={users}
        myId={identity.id}
        myPosition={identity.position}
        myColor={identity.color}
        onAvatarClick={handleAvatarClick}
      />

      {/* ── HUD Overlay ── */}
      <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-xl p-4 shadow-lg border border-slate-200 max-w-xs">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="font-semibold text-slate-800">Connected</span>
        </div>
        <p className="text-xs text-slate-500 font-mono mb-3">
          ID: {identity.id.slice(0, 8)}
        </p>
      </div>

      {/* User count */}
      <div className="absolute top-4 right-4 bg-white/90 backdrop-blur rounded-xl px-4 py-2 shadow-lg border border-slate-200">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-slate-700" />
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="text-sm font-semibold text-slate-700">
            {users.length + 1}
          </span>
        </div>
      </div>

      {showWorldBot && (
        <WorldBot
          message={worldBotMessage}
          onClose={() => {
            setIsBotClosed(true);
            setNotice(null);
          }}
        />
      )}

      {/* ── Outgoing invitation modal ── */}
      {outgoingTarget && (
        <OutgoingInvitationModal
          targetId={outgoingTarget}
          status={outgoingStatus}
          onSend={sendInvitation}
          onCancel={cancelOutgoing}
        />
      )}

      {/* ── Incoming invitation modal ── */}
      {incomingRequest && !outgoingTarget && (
        <IncomingInvitationModal
          fromId={incomingRequest}
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}
    </div>
  );
}

export default App;
