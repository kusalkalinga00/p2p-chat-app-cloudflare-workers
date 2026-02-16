import { useState, useRef, useEffect, useCallback } from "react";
import { IslandWorld } from "./components/IslandWorld";
import {
  PrivateChat,
  type ChatMessage,
  type RtcStatus,
} from "./components/PrivateChat";
import {
  OutgoingInvitationModal,
  IncomingInvitationModal,
} from "./components/InvitationModal";
import { Wifi, WifiOff, Loader2, Users } from "lucide-react";
import type { OutgoingStatus, User, View } from "./types/index.types";
import {
  INVITATION_TIMEOUT_MS,
  STUN_SERVERS,
  WORLD_WSS_URL,
} from "./lib/constants";
import { randomColor, randomPosition } from "./lib/utils";

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

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const myId = useRef(crypto.randomUUID());
  const myColor = useRef(randomColor());
  const myPosition = useRef(randomPosition());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOfferer = useRef(false);
  const reconnectingRef = useRef(false);
  const joinSoundRef = useRef<HTMLAudioElement | null>(null);
  const inviteSoundRef = useRef<HTMLAudioElement | null>(null);
  const messageSoundRef = useRef<HTMLAudioElement | null>(null);
  const lastMessageSoundAtRef = useRef(0);

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

  const wsSend = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  // ────────────────────────────────────────────────────────────────
  // WebRTC helpers
  // ────────────────────────────────────────────────────────────────

  /** Tear down the RTCPeerConnection & DataChannel cleanly. */
  const cleanupRtc = useCallback(() => {
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setRtcStatus("disconnected");
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
          { from: "peer", text: e.data, timestamp: Date.now() },
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
      cleanupRtc();

      const pc = new RTCPeerConnection(STUN_SERVERS);
      pcRef.current = pc;
      setRtcStatus("connecting");

      // Relay ICE candidates via the World DO
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          wsSend({
            type: "rtc-ice-candidate",
            target: targetId,
            payload: e.candidate.toJSON(),
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

      wsSend({
        type: "rtc-offer",
        target: targetId,
        payload: pc.localDescription!.toJSON(),
      });

      console.log("[WebRTC] Sent offer to", targetId);
    },
    [createPeerConnection, setupDataChannel, wsSend],
  );

  /** Answerer: handle the incoming offer, create answer. */
  const handleOffer = useCallback(
    async (fromId: string, offer: RTCSessionDescriptionInit) => {
      const pc = createPeerConnection(fromId);

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      wsSend({
        type: "rtc-answer",
        target: fromId,
        payload: pc.localDescription!.toJSON(),
      });

      console.log("[WebRTC] Sent answer to", fromId);
    },
    [createPeerConnection, wsSend],
  );

  /** Offerer: handle the returned answer. */
  const handleAnswer = useCallback(
    async (answer: RTCSessionDescriptionInit) => {
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log("[WebRTC] Remote description set (answer)");
    },
    [],
  );

  /** Both sides: add ICE candidate. */
  const handleIceCandidate = useCallback(
    async (candidate: RTCIceCandidateInit) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
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

      // Mark ourselves as unavailable so no one else can invite us
      wsSend({ type: "set-available", available: false });

      // Set chat state
      setChatTarget(peerId);
      setMessages([]);
      isOfferer.current = offerer;
      setView("chat");

      // The offerer kicks off WebRTC negotiations
      if (offerer) {
        startOffer(peerId);
      }
      // (The answerer waits for the rtc-offer message, handled in handleMessage)
    },
    [startOffer, wsSend],
  );

  // ────────────────────────────────────────────────────────────────
  // Transition: leave chat and return to world
  // ────────────────────────────────────────────────────────────────

  const leaveChat = useCallback(() => {
    cleanupRtc();
    setChatTarget(null);
    setMessages([]);
    setView("world");

    // Mark ourselves as available again — keep the WebSocket open
    // so there's no reconnect race condition.
    wsSend({ type: "set-available", available: true });
  }, [cleanupRtc, wsSend]);

  // ────────────────────────────────────────────────────────────────
  // WebSocket message handler
  // ────────────────────────────────────────────────────────────────

  const handleMessage = useCallback(
    (data: Record<string, any>) => {
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
          }
          break;

        case "user-left":
          setUsers((prev) => prev.filter((u) => u.id !== data.id));
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
          handleOffer(data.from, data.payload);
          break;

        case "rtc-answer":
          handleAnswer(data.payload);
          break;

        case "rtc-ice-candidate":
          handleIceCandidate(data.payload);
          break;
      }
    },
    [
      view,
      incomingRequest,
      enterChat,
      handleOffer,
      handleAnswer,
      handleIceCandidate,
      playSound,
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

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setIsConnecting(true);
    const ws = new WebSocket(`${WORLD_WSS_URL}/world/world?id=${myId.current}`);

    ws.onopen = () => {
      setConnected(true);
      setIsConnecting(false);
      ws.send(
        JSON.stringify({
          type: "spawn",
          x: myPosition.current[0],
          y: myPosition.current[1],
          z: myPosition.current[2],
          color: myColor.current,
          available: true,
        }),
      );
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleMessageRef.current(data);
    };

    ws.onclose = () => {
      setConnected(false);
      setIsConnecting(false);
      setUsers([]);
      reconnectingRef.current = true;
      wsRef.current = null;
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setIsConnecting(false);
    };

    wsRef.current = ws;
  }, [WORLD_WSS_URL]);

  // Auto-reconnect only on unexpected disconnect (e.g. server restart).
  // We no longer close the WS when entering/leaving chat.
  useEffect(() => {
    if (view === "world" && !connected && !isConnecting && !wsRef.current) {
      // Small delay so the previous socket finishes closing
      const t = setTimeout(connect, 300);
      return () => clearTimeout(t);
    }
  }, [view, connected, isConnecting, connect]);

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
    wsSend({ type: "chat-request", target: outgoingTarget });
    setOutgoingStatus("waiting");

    // Start 15 s timeout
    timeoutRef.current = setTimeout(() => {
      setOutgoingStatus("timeout");
    }, INVITATION_TIMEOUT_MS);
  }, [outgoingTarget, wsSend]);

  /** Dismiss outgoing modal (cancel / close after timeout). */
  const cancelOutgoing = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOutgoingTarget(null);
    setOutgoingStatus("idle");
  }, []);

  /** User accepted an incoming request. */
  const acceptIncoming = useCallback(() => {
    if (!incomingRequest) return;
    const roomId = [myId.current, incomingRequest].sort().join("-");
    wsSend({
      type: "chat-response",
      target: incomingRequest,
      accept: true,
      roomId,
    });
    // Answerer enters chat (will receive rtc-offer shortly)
    enterChat(incomingRequest, false);
  }, [incomingRequest, wsSend, enterChat]);

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
      { from: "me", text, timestamp: Date.now() },
    ]);
  }, []);

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
        myId={myId.current}
        myPosition={myPosition.current}
        myColor={myColor.current}
        onAvatarClick={handleAvatarClick}
      />

      {/* ── HUD Overlay ── */}
      <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-xl p-4 shadow-lg border border-slate-200 max-w-xs">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="font-semibold text-slate-800">Connected</span>
        </div>
        <p className="text-xs text-slate-500 font-mono mb-3">
          ID: {myId.current.slice(0, 8)}
        </p>
        <p className="text-sm text-slate-600 mb-4">
          Click on another avatar to chat
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
