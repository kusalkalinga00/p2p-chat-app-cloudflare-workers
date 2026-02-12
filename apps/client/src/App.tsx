import { useState, useRef } from "react";
import { Wifi, WifiOff, Loader2, LogIn, LogOut, Hash } from "lucide-react";

function App() {
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [roomId, setRoomId] = useState("general");

  const wsRef = useRef<WebSocket | null>(null);
  const myId = useRef(crypto.randomUUID().slice(0, 8));

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setIsConnecting(true);
    const ws = new WebSocket(
      `ws://localhost:8787/room/${roomId}?id=${myId.current}`,
    );

    ws.onopen = () => {
      setConnected(true);
      setIsConnecting(false);
      console.log("Connected to room:", roomId);
    };

    ws.onclose = () => {
      setConnected(false);
      setIsConnecting(false);
      wsRef.current = null;
      console.log("Disconnected");
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setConnected(false);
      setIsConnecting(false);
    };

    wsRef.current = ws;
  };

  const disconnect = () => {
    wsRef.current?.close();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200">
            <Hash className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-1">P2P Chat</h1>
          <p className="text-sm text-slate-500 font-mono">
            Your ID: {myId.current}
          </p>
        </div>

        {/* Connection Card */}
        <div className="space-y-6">
          {/* Room Input */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Room Name
            </label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                disabled={connected}
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-100 disabled:text-slate-400 font-medium transition-all"
                placeholder="Enter room name"
              />
            </div>
          </div>

          {/* Status Indicator */}
          <div className="flex items-center justify-center gap-3 py-4 bg-slate-50 rounded-xl border border-slate-100">
            {connected ? (
              <>
                <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                <Wifi className="w-5 h-5 text-green-600" />
                <span className="font-medium text-green-700">Connected</span>
              </>
            ) : isConnecting ? (
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

          {/* Connect Button */}
          {!connected ? (
            <button
              onClick={connect}
              disabled={isConnecting || !roomId.trim()}
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white rounded-xl font-semibold transition-all shadow-lg shadow-blue-200 hover:shadow-xl hover:shadow-blue-200 active:scale-[0.98]"
            >
              {isConnecting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <LogIn className="w-5 h-5" />
              )}
              {isConnecting ? "Connecting..." : "Connect to Room"}
            </button>
          ) : (
            <button
              onClick={disconnect}
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-xl font-semibold transition-all active:scale-[0.98]"
            >
              <LogOut className="w-5 h-5" />
              Disconnect
            </button>
          )}
        </div>

        {/* Footer Info */}
        <div className="mt-6 pt-6 border-t border-slate-100 text-center">
          <p className="text-xs text-slate-400">
            WebSocket endpoint: ws://localhost:8787
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
