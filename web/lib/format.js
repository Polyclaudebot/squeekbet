// Formatting and input parsing. Everything that ends up in innerHTML goes through esc().
import { formatEther, parseEther } from "../vendor/viem.js";

export const now = () => Math.floor(Date.now() / 1000);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

export function fmtTime(ts) {
  const d = new Date(ts * 1000), t = new Date(now() * 1000);
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === t.toDateString() ? hm : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + ", " + hm;
}

export function fmtDur(s) {
  if (s <= 0) return "0m";
  const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export const sqk = (v) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const int = (v) => Number(v).toLocaleString("en-US");

// Plain decimal SQK amounts only: no sign, no exponent, at most 18 decimals, capped at 1e12 SQK.
const AMOUNT_RE = /^\d{1,12}(\.\d{1,18})?$/;
export function parseAmount(s) {
  const v = String(s ?? "").trim().replace(",", ".");
  return AMOUNT_RE.test(v) ? parseEther(v) : null;
}
