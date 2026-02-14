export const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export const INVITATION_TIMEOUT_MS = 15_000;

export const WORLD_WSS_URL = import.meta.env.VITE_WORLD_WSS_URL;
