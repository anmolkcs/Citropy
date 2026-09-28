import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { dev, developmentOrigin, port } from "./config.ts";
import { allowThroughFirewall, firewallBlock, subnetOf, type FirewallBlock } from "./firewall.ts";
import { onShutdown } from "./lifecycle.ts";
import { dataRoot } from "./paths.ts";
import { writeLog } from "./logs.ts";
import { remoteId } from "./remote.ts";

export const LAN_DEVICE_HEADER = "x-citropy-lan-device";

interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

interface Saved {
  enabled: boolean;
  devices: Device[];
}

export interface SharingState {
  enabled: boolean;
  addresses: string[];
  error?: string;
  firewall?: FirewallBlock;
  devices: Array<Omit<Device, "tokenHash">>;
}

const file = join(dataRoot, "lan-sharing.json");
const cookieName = "citropy_device";
const pairingLifetime = 5 * 60_000;
const target = new URL(dev ? developmentOrigin : `http://127.0.0.1:${port}`);
const listeners = new Map<string, Server>();
const pairings = new Map<string, number>();
const openConnections = new Map<string, Set<Duplex>>();
let saved = load();
let listenError: string | undefined;
let rescan: NodeJS.Timeout | undefined;
let lastSeenSaved = 0;
let subnets = new Map<string, string>();

function load(): Saved {
  if (!existsSync(file)) return { enabled: false, devices: [] };
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
  return { enabled: data.enabled === true, devices: Array.isArray(data.devices) ? data.devices : [] };
}

function save(): void {
  writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function privateAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

function lanAddresses(): Map<string, string> {
  return new Map(Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal && privateAddress(entry.address) && entry.cidr)
    .map((entry) => [entry!.address, entry!.cidr!]));
}

function deviceName(userAgent = ""): string {
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Macintosh/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows computer";
  return "Browser";
}

function authenticate(req: IncomingMessage): Device | undefined {
  const cookie = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!cookie) return undefined;
  const supplied = hash(cookie.slice(cookieName.length + 1));
  const device = saved.devices.find((entry) => sameHash(entry.tokenHash, supplied));
  if (device) {
    device.lastSeen = Date.now();
    if (device.lastSeen - lastSeenSaved > 60_000) {
      lastSeenSaved = device.lastSeen;
      save();
    }
  }
  return device;
}

function track(device: Device, connection: Duplex): void {
  let set = openConnections.get(device.id);
  if (!set) openConnections.set(device.id, (set = new Set()));
  set.add(connection);
  connection.once("close", () => set.delete(connection));
}

function forwardedHeaders(headers: IncomingHttpHeaders, device: Device): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = { ...headers, host: target.host, [LAN_DEVICE_HEADER]: device.id };
  if (result.origin) result.origin = target.origin;
  delete result.referer;
  return result;
}

function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Citropy</title>` +
    `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1e1e1e;color:#e8e8e8;font:16px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">` +
    `<p style="max-width:28ch;line-height:1.5">${message}</p>`,
  );
}

function pair(code: string | null, req: IncomingMessage, res: ServerResponse): void {
  const key = code ? hash(code) : "";
  const expiresAt = pairings.get(key);
  if (!expiresAt || expiresAt < Date.now()) {
    page(res, 403, "This pairing code has expired or was already used. Open Local sharing in Citropy on your computer and scan the new code.");
    return;
  }
  pairings.delete(key);
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  saved.devices.push({ id: randomUUID(), name: deviceName(req.headers["user-agent"]), tokenHash: hash(token), createdAt: now, lastSeen: now });
  save();
  res.writeHead(302, {
    location: "/",
    "cache-control": "no-store",
    "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=315360000`,
  }).end();
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://lan");
  if (url.pathname === "/pair") return pair(url.searchParams.get("code"), req, res);
  const device = authenticate(req);
  if (!device) return page(res, 401, "This device is not paired. Open Local sharing in Citropy on your computer and scan the QR code.");
  if (url.pathname.startsWith("/mcp/")) {
    res.writeHead(403).end();
    return;
  }
  track(device, req.socket);
  const upstream = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: forwardedHeaders(req.headers, device) }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  req.pipe(upstream);
}

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const device = authenticate(req);
  if (!device || new URL(req.url ?? "/", "http://lan").pathname.startsWith("/mcp/")) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(Number(target.port), target.hostname);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
  track(device, socket);
  upstream.once("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(forwardedHeaders(req.headers, device)))
      for (const entry of [value].flat()) if (entry !== undefined) lines.push(`${name}: ${entry}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
}

function listen(): void {
  const wanted = lanAddresses();
  subnets = new Map([...wanted].map(([address, cidr]) => [address, subnetOf(cidr)]));
  for (const [address, server] of listeners)
    if (!wanted.has(address)) {
      server.close();
      listeners.delete(address);
    }
  for (const address of wanted.keys()) {
    if (listeners.has(address)) continue;
    const server = createServer(handle);
    server.on("upgrade", upgrade);
    server.on("error", (error: NodeJS.ErrnoException) => {
      listeners.delete(address);
      listenError = error.code === "EADDRINUSE" ? `Port ${port} on ${address} is already in use.` : error.message;
      writeLog("error", "sharing", listenError);
    });
    server.listen(port, address, () => { listenError = undefined; });
    listeners.set(address, server);
  }
}

function stop(): void {
  clearInterval(rescan);
  rescan = undefined;
  for (const server of listeners.values()) {
    server.close();
    server.closeAllConnections();
  }
  listeners.clear();
  for (const connections of openConnections.values()) for (const connection of connections) connection.destroy();
  openConnections.clear();
  pairings.clear();
}

function start(): void {
  listen();
  rescan ??= setInterval(listen, 30_000);
  rescan.unref();
}

function primarySubnet(): string | undefined {
  const [address] = listeners.keys();
  return address ? subnets.get(address) : undefined;
}

export function sharingState(): SharingState {
  const subnet = primarySubnet();
  const firewall = saved.enabled && subnet ? firewallBlock(port, subnet) : undefined;
  return {
    enabled: saved.enabled,
    addresses: [...listeners.keys()].map((address) => `http://${address}:${port}`),
    ...(listenError ? { error: listenError } : {}),
    ...(firewall ? { firewall } : {}),
    devices: saved.devices.map(({ tokenHash: _, ...device }) => device),
  };
}

export function setSharing(enabled: boolean): SharingState {
  if (remoteId) throw new Error("Local sharing is available only on the computer running Citropy.");
  saved.enabled = enabled;
  save();
  if (enabled) start();
  else stop();
  return sharingState();
}

export function createPairing(): { url: string; expiresAt: number } {
  if (!saved.enabled) throw new Error("Turn on local sharing first.");
  const [address] = listeners.keys();
  if (!address) throw new Error("No Wi-Fi or local network connection was found on this computer.");
  const code = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + pairingLifetime;
  for (const [key, expiry] of pairings) if (expiry < Date.now()) pairings.delete(key);
  pairings.set(hash(code), expiresAt);
  return { url: `http://${address}:${port}/pair?code=${code}`, expiresAt };
}

export async function openFirewall(): Promise<SharingState> {
  const subnet = primarySubnet();
  if (!subnet) throw new Error("No Wi-Fi or local network connection was found on this computer.");
  await allowThroughFirewall(port, subnet);
  return sharingState();
}

export function removeDevice(id: string): SharingState {
  saved.devices = saved.devices.filter((device) => device.id !== id);
  save();
  for (const connection of openConnections.get(id) ?? []) connection.destroy();
  openConnections.delete(id);
  return sharingState();
}

if (saved.enabled && !remoteId) start();
onShutdown(async () => stop());
