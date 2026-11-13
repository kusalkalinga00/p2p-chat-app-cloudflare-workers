import { useState, useRef, useEffect, useCallback } from "react";
import { IslandWorld } from "./components/IslandWorld";
import { PrivateChat } from "./components/PrivateChat";
import {
  OutgoingInvitationModal,
  IncomingInvitationModal,
} from "./components/InvitationModal";
import { WorldBot } from "./components/WorldBot";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
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
import { INVITATION_TIMEOUT_MS, WORLD_ORIGIN } from "./lib/constants";
import { getIceConfig, prefetchIceConfig } from "./lib/ice";
import { ChatCipher, E2EE_VERSION } from "./lib/e2ee";
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
  /** E2EE handshake finished and message chains are usable. */
  const [e2eeReady, setE2eeReady] = useState(false);
  /** Both ends proved they derived the same secret (HMAC confirmation). */
  const [e2eeConfirmed, setE2eeConfirmed] = useState(false);
  /** Set when the handshake or confirmation fails; blocks the composer. */
  const [e2eeError, setE2eeError] = useState<string | null>(null);
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

  /** Per-chat end-to-end encryption state; discarded when the chat ends. */
  const cipherRef = useRef<ChatCipher | null>(null);
  /** True once this side's confirmation tag has been put on the wire. */
  const confirmSentRef = useRef(false);
  /** Peer confirmation that arrived before our keys were derived. */
  const pendingPeerConfirmRef = useRef<string | null>(null);

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
    // Do NOT clear the confirmation buffers here: createPeerConnection calls
    // this during setup, and the key exchange can finish before the WebRTC
    // offer arrives. Dropping a buffered tag at that point leaves this side
    // waiting for a confirmation it already has, and the peer never gets one.
    // enterChat/leaveChat clear them at the real session boundaries.
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

  /**
   * Verifies the peer's key-confirmation tag. The tag travels over the
   * DataChannel rather than the signalling relay, so a Worker deployment that
   * is behind the client cannot wedge the handshake.
   */
  const applyConfirmation = useCallback(async (tag: string) => {
    const cipher = cipherRef.current;
    if (!cipher) return;
    try {
      await cipher.verifyConfirmation(tag);
      setE2eeConfirmed(cipher.confirmed);
    } catch (err) {
      console.error("[e2ee] key confirmation failed:", err);
      setE2eeError(
        "The encryption handshake did not complete. Leave and start the chat again.",
      );
    }
  }, []);

  /**
   * Sends this side's confirmation tag once the DataChannel can carry it.
   *
   * The key exchange and the channel open in either order, so both the key
   * handler and `onopen` call this. `confirmSentRef` makes it idempotent, and
   * the tag is recomputed instead of buffered — a buffered tag can be dropped
   * by a peer-connection reset, which leaves one side confirmed and the other
   * waiting forever.
   */
  const sendConfirmTag = useCallback((dc: RTCDataChannel) => {
    const cipher = cipherRef.current;
    if (!cipher?.ready || confirmSentRef.current) return;

    confirmSentRef.current = true;
    void cipher
      .confirmationTag()
      .then((tag) => {
        if (dc.readyState === "open") {
          dc.send(JSON.stringify({ t: "confirm", tag }));
        } else {
          confirmSentRef.current = false;
        }
      })
      .catch((err) => {
        confirmSentRef.current = false;
        console.error("[e2ee] could not build the confirmation tag:", err);
      });
  }, []);

  /** Wire up DataChannel events (shared by offerer & answerer). */
  const setupDataChannel = useCallback(
    (dc: RTCDataChannel) => {
      dcRef.current = dc;

      dc.onopen = () => {
        console.log("[WebRTC] DataChannel open");
        setRtcStatus("connected");
        // Keys are often derived before the channel opens.
        sendConfirmTag(dc);
      };

      dc.onclose = () => {
        console.log("[WebRTC] DataChannel closed");
        setRtcStatus("disconnected");
      };

      dc.onmessage = async (e) => {
        const cipher = cipherRef.current;

        let frame: { t?: unknown; tag?: unknown; n?: unknown; c?: unknown };
        try {
          frame = JSON.parse(String(e.data));
        } catch {
          console.warn("[e2ee] dropped a frame that was not JSON");
          return;
        }

        // Control frame: the key-confirmation tag. It is not user content.
        if (frame.t === "confirm") {
          if (typeof frame.tag !== "string") return;
          if (!cipher?.ready) {
            // The key exchange and the channel can race. Hold the tag until
            // derive() finishes; the key handler applies it.
            pendingPeerConfirmRef.current = frame.tag;
            return;
          }
          await applyConfirmation(frame.tag);
          return;
        }

        // Everything else on this channel is ciphertext. A frame that is not
        // a well-formed envelope is dropped rather than shown: never render
        // unverified bytes as if a peer had sent them.
        if (
          !cipher?.ready ||
          typeof frame.n !== "number" ||
          typeof frame.c !== "string"
        ) {
          console.warn("[e2ee] dropped a malformed message envelope");
          return;
        }

        let text: string;
        try {
          text = await cipher.decrypt({ n: frame.n, c: frame.c });
        } catch (err) {
          console.warn("[e2ee] decryption failed:", err);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              from: "peer",
              text: "⚠️ A message arrived that could not be decrypted.",
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            from: "peer",
            text,
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
    [applyConfirmation, playSound, sendConfirmTag],
  );

  /** Create a new peer connection and hook it up. */
  const createPeerConnection = useCallback(
    (targetId: string, config: RTCConfiguration) => {
      // Candidates can arrive before the offer does. Hold on to them:
      // cleanupRtc() below resets the queue, which would drop them.
      const early = pendingCandidatesRef.current;

      cleanupRtc();
      pendingCandidatesRef.current = early;

      const pc = new RTCPeerConnection(config);
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
      const config = await getIceConfig();
      const pc = createPeerConnection(targetId, config);

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
      const config = await getIceConfig();
      const pc = createPeerConnection(fromId, config);

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
      setE2eeReady(false);
      setE2eeConfirmed(false);
      setE2eeError(null);
      confirmSentRef.current = false;
      pendingPeerConfirmRef.current = null;

      // Start the E2EE handshake alongside the WebRTC one. The role decides
      // which of the two derived chains each side sends on, so the two ends
      // never reuse a key or nonce in the same direction.
      const roomId = [identity.id, peerId].sort().join("-");
      const cipher = new ChatCipher(
        roomId,
        offerer ? "initiator" : "responder",
      );
      cipherRef.current = cipher;

      void cipher
        .init()
        .then((publicKey) => {
          wsSend({
            type: "e2ee-key",
            target: peerId,
            payload: { publicKey, version: E2EE_VERSION },
          });
        })
        .catch((err) => {
          console.error("[e2ee] key generation failed:", err);
          setE2eeError("Could not generate encryption keys.");
        });

      // The offerer kicks off WebRTC negotiations
      if (offerer) {
        void startOffer(peerId);
      }
      // (The answerer waits for the rtc-offer message, handled in handleMessage)
    },
    [identity.id, startOffer, wsSend],
  );

  // ────────────────────────────────────────────────────────────────
  // Transition: leave chat and return to world
  // ────────────────────────────────────────────────────────────────

  const leaveChat = useCallback(() => {
    cleanupRtc();
    // Drop the keys with the chat: the next conversation is a new session and
    // gets new ephemeral keys, so past messages cannot be read from this state.
    cipherRef.current = null;
    confirmSentRef.current = false;
    pendingPeerConfirmRef.current = null;
    setE2eeReady(false);
    setE2eeConfirmed(false);
    setE2eeError(null);
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

        case "e2ee-key":
          void (async () => {
            const cipher = cipherRef.current;
            if (!cipher) return;

            if (data.payload.version !== E2EE_VERSION) {
              console.error(
                `[e2ee] protocol version mismatch (peer ${data.payload.version}, local ${E2EE_VERSION})`,
              );
              setE2eeError(
                "The other side is running an incompatible version of the app.",
              );
              return;
            }

            try {
              // Safe even if our own key generation has not settled yet:
              // derive() waits for it rather than dropping the peer's key.
              await cipher.derive(data.payload.publicKey);
              setE2eeReady(cipher.ready);

              // The tag travels peer to peer on the DataChannel, not through
              // the signalling relay, so a Worker deployment that is behind
              // the client cannot wedge the handshake. If the channel is not
              // open yet, dc.onopen sends it instead.
              const dc = dcRef.current;
              if (dc) sendConfirmTag(dc);

              // A confirmation can arrive on the DataChannel before the key
              // exchange finishes. Apply it now that derive() has completed.
              const buffered = pendingPeerConfirmRef.current;
              if (buffered) {
                pendingPeerConfirmRef.current = null;
                await applyConfirmation(buffered);
              }
            } catch (err) {
              console.error("[e2ee] key agreement failed:", err);
              setE2eeError("Could not establish encryption with this peer.");
            }
          })();
          break;

        case "peer-left":
          if (chatTarget === data.id) {
            setNotice("Your chat partner disconnected.");
            leaveChat();
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
      applyConfirmation,
      sendConfirmTag,
      leaveChat,
      playSound,
      showUserChange,
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
    const ws = new WebSocket(`${WORLD_ORIGIN}/world/world?id=${identity.id}`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
      setIsConnecting(false);

      // Resolve ICE servers (TURN credentials) while the user is still
      // looking at the world, so joining a chat is instant.
      prefetchIceConfig();

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
    const cipher = cipherRef.current;
    // No plaintext fallback: the channel, the keys and the cryptographic
    // confirmation must all be in place.
    if (
      !dc ||
      dc.readyState !== "open" ||
      !cipher?.ready ||
      !cipher.confirmed
    ) {
      return;
    }

    // Show it locally straight away; the wire only ever sees ciphertext.
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), from: "me", text, timestamp: Date.now() },
    ]);

    void cipher
      .encrypt(text)
      .then((envelope) => {
        if (dc.readyState === "open") {
          dc.send(JSON.stringify({ v: 1, ...envelope }));
        }
      })
      .catch((err) => console.error("[e2ee] encryption failed:", err));
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
      <div className="min-h-dvh bg-cream flex flex-col items-center justify-center p-6">
        <div className="buoy-card w-full max-w-md p-8 text-center">
          <h1 className="text-3xl font-black tracking-tight">Island Chat</h1>
          <p className="mt-1.5 text-sm font-medium text-ink/70">
            A small floating island. Spot someone, say hello.
          </p>

          <div className="mt-6 flex justify-center">
            {isConnecting ? (
              <span className="sticker bg-mustard px-4 py-1.5 text-sm font-extrabold">
                <Loader2 className="w-4 h-4 animate-spin" />
                Connecting…
              </span>
            ) : (
              <span className="sticker px-4 py-1.5 text-sm font-extrabold text-ink/70">
                <WifiOff className="w-4 h-4" />
                Not connected
              </span>
            )}
          </div>

          <button
            onClick={connect}
            disabled={isConnecting}
            className="sticker-btn mt-5 w-full bg-coral px-6 py-3.5 text-base text-ink"
          >
            {isConnecting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Wifi className="w-5 h-5" />
            )}
            {isConnecting ? "Connecting…" : "Enter World"}
          </button>
        </div>

        <p className="mt-6 font-mono text-[10px] tracking-[0.18em] uppercase text-ink/60">
          peer to peer · nothing stored
        </p>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Render: Private Chat view
  // ────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────
  // Render: the world, with the chat docked over it
  //
  // The chat is an overlay rather than a separate view: keeping the canvas
  // mounted means you can still watch the island while talking, and leaving
  // the chat returns to exactly the camera you left rather than rebuilding it.
  // ────────────────────────────────────────────────────────────────

  const isChatting = view === "chat" && chatTarget !== null;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-cream">
      {/* 3D World */}
      <IslandWorld
        users={users}
        myId={identity.id}
        myPosition={identity.position}
        myColor={identity.color}
        onAvatarClick={handleAvatarClick}
      />

      {!isChatting && (
        <>
          {/* ── HUD ── */}
          <div className="absolute top-4 left-4 z-10 flex flex-col items-start gap-2">
            <span className="sticker px-3.5 py-1.5 text-xs font-extrabold">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-ink bg-teal" />
              {users.length + 1} on the island
            </span>
            <span className="sticker px-3 py-1 text-[11px] font-bold text-ink/70">
              you · {identity.id.slice(0, 8)}
            </span>
          </div>

          <div className="absolute top-4 right-4 z-10">
            <span className="sticker bg-teal px-3.5 py-1.5 text-xs font-extrabold text-ink">
              online
            </span>
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
        </>
      )}

      {isChatting && (
        <PrivateChat
          peerId={chatTarget}
          messages={messages}
          rtcStatus={rtcStatus}
          onSend={sendChatMessage}
          onLeave={leaveChat}
          e2ee={{
            ready: e2eeReady,
            confirmed: e2eeConfirmed,
            error: e2eeError,
          }}
        />
      )}
    </div>
  );
}

export default App;
