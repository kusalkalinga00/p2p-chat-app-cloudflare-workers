export function hslToHex(h: number, s: number, l: number): string {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export function randomColor() {
  return hslToHex(Math.random() * 360, 0.7, 0.6);
}

export function randomPosition(): [number, number, number] {
  return [(Math.random() - 0.5) * 8, 0.5, (Math.random() - 0.5) * 8];
}
