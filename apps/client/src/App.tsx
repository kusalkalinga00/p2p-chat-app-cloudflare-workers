import { useState, useRef, useEffect } from "react";
import { IslandWorld } from "./components/IslandWorld";
import { Wifi, WifiOff, Loader2 } from "lucide-react";

interface User {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  available: boolean;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [incomingRequest, setIncomingRequest] = useState<string | null>(null);
  const [targetUser, setTargetUser] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const myId = useRef(crypto.randomUUID());
  const myColor = useRef(`hsl(${Math.random() * 360}, 70%, 60%)`);

  const WORLD_WSS_URL = import.meta.env.VITE_WORLD_WSS_URL;

  // Random spawn position
  const myPosition = useRef<[number, number, number]>([
    (Math.random() - 0.5) * 8,
    0.5,
    (Math.random() - 0.5) * 8,
  ]);

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setIsConnecting(true);
    const ws = new WebSocket(`${WORLD_WSS_URL}/world/world?id=${myId.current}`);

    ws.onopen = () => {
      setConnected(true);
      setIsConnecting(false);
      // Send spawn position
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
      handleMessage(data);
    };

    ws.onclose = () => {
      setConnected(false);
      setIsConnecting(false);
      setUsers([]);
      wsRef.current = null;
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setIsConnecting(false);
    };

    wsRef.current = ws;
  };

  const handleMessage = (data: any) => {
    switch (data.type) {
      case "world-state":
        // Received current list of all users
        setUsers(data.users);
        break;
      case "user-joined":
        setUsers((prev) => [
          ...prev.filter((u) => u.id !== data.user.id),
          data.user,
        ]);
        break;
      case "user-left":
        setUsers((prev) => prev.filter((u) => u.id !== data.id));
        break;
      case "chat-request":
        // Someone clicked on us
        setIncomingRequest(data.from);
        setShowRequestModal(true);
        break;
      case "chat-response":
        if (data.accept) {
          // Navigate to private room (we'll implement next)
          console.log("Chat accepted! Navigate to room:", data.roomId);
        } else {
          alert("User declined chat request");
        }
        break;
    }
  };

  const sendChatRequest = (targetId: string) => {
    if (!wsRef.current) return;
    setTargetUser(targetId);
    wsRef.current.send(
      JSON.stringify({
        type: "chat-request",
        target: targetId,
      }),
    );
  };

  const respondToRequest = (accept: boolean) => {
    if (!wsRef.current || !incomingRequest) return;

    const roomId = [myId.current, incomingRequest].sort().join("-");

    wsRef.current.send(
      JSON.stringify({
        type: "chat-response",
        target: incomingRequest,
        accept,
        roomId,
      }),
    );

    setShowRequestModal(false);
    setIncomingRequest(null);

    if (accept) {
      // Navigate to private chat
      console.log("Joining room:", roomId);
    }
  };

  const disconnect = () => {
    wsRef.current?.close();
  };

  if (!connected) {
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
                <span className="font-medium text-blue-700">Connecting...</span>
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
            {isConnecting ? "Connecting..." : "Enter World"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen">
      {/* 3D World */}
      <IslandWorld
        users={users}
        myId={myId.current}
        myPosition={myPosition.current}
        myColor={myColor.current}
        onAvatarClick={sendChatRequest}
      />

      {/* UI Overlay */}
      <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-xl p-4 shadow-lg border border-slate-200 max-w-xs">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="font-semibold text-slate-800">Connected</span>
        </div>
        <p className="text-xs text-slate-500 font-mono mb-3">
          ID: {myId.current.slice(0, 8)}
        </p>
        <p className="text-sm text-slate-600 mb-4">
          Click on other spheres to chat
        </p>
        <button
          onClick={disconnect}
          className="w-full px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm font-medium transition-colors"
        >
          Leave World
        </button>
      </div>

      {/* User count */}
      <div className="absolute top-4 right-4 bg-white/90 backdrop-blur rounded-xl px-4 py-2 shadow-lg border border-slate-200">
        <span className="text-sm font-medium text-slate-700">
          {users.length + 1} users online
        </span>
      </div>

      {/* Chat Request Modal */}
      {showRequestModal && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800 mb-2">
              Chat Request
            </h3>
            <p className="text-slate-600 mb-6">
              User{" "}
              <span className="font-mono font-medium">
                {incomingRequest?.slice(0, 8)}
              </span>{" "}
              wants to chat with you
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => respondToRequest(false)}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium transition-colors"
              >
                Decline
              </button>
              <button
                onClick={() => respondToRequest(true)}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Waiting for response indicator */}
      {targetUser && !incomingRequest && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur rounded-full px-6 py-3 shadow-lg border border-slate-200">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            <span className="text-sm font-medium text-slate-700">
              Waiting for {targetUser.slice(0, 8)} to respond...
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
