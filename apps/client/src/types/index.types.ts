export interface User {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  available: boolean;
}

export type View = "world" | "chat";
export type OutgoingStatus = "idle" | "waiting" | "timeout" | "declined";