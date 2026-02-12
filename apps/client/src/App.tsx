import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    fetch("/api")
      .then((res) => res.text())
      .then((text) => setStatus(`Server says: ${text}`))
      .catch((err) => setStatus(`Error: ${err.message}`));
  }, []);

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>P2P Chat</h1>
      <p>Status: {status}</p>
    </div>
  );
}

export default App;
