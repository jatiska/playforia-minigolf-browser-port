// Regression: reconnect must not send DATA with a stale outSeq before `c rcok`.
//
// The web client's game RAF loop (cursor, endstroke, ballend) keeps running
// while the reconnect socket is OPEN but the handshake (`c ctr` → `c old` →
// `c rcok`) is still in flight. A fresh server Connection expects inbound
// DATA seq 0; any packet with seq > 0 trips seq-mismatch and kills the socket
// before catchup can land.
//
// The web fix is in connection.ts: sendData() is a no-op while reconnecting,
// and outSeq resets to 0 when the reconnect socket opens. This server test
// documents the failure mode a buggy client would hit.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-reconnect-stale-outseq.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4256;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

class Client {
    name: string;
    ws: WebSocket;
    outSeq = 0;
    closed = false;
    readonly received: string[] = [];

    constructor(name: string) {
        this.name = name;
        this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        this.ws.on("message", (m) => {
            this.received.push(m.toString());
        });
        this.ws.on("close", () => {
            this.closed = true;
        });
    }

    async open(): Promise<void> {
        await new Promise<void>((r) => this.ws.once("open", () => r()));
    }

    send(line: string): void {
        this.ws.send(line);
    }

    sendData(...fields: (string | number)[]): void {
        this.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }

    sendCommand(verb: string, ...args: string[]): void {
        this.send(`c ${[verb, ...args].join(" ")}`);
    }

    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 5000): Promise<string> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`[${this.name}] timeout: ${label}`)), timeoutMs);
            const tick = (): void => {
                const idx = this.received.findIndex(predicate);
                if (idx >= 0) {
                    clearTimeout(t);
                    const [s] = this.received.splice(idx, 1);
                    resolve(s);
                    return;
                }
                setTimeout(tick, 20);
            };
            tick();
        });
    }

    terminate(): void {
        this.ws.terminate();
    }
}

async function login(c: Client): Promise<number> {
    await c.waitFor((s) => s === "h 1", "h 1");
    await c.waitFor((s) => s.startsWith("c crt"), "c crt");
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("new");
    const idLine = await c.waitFor((s) => s.startsWith("c id "), "c id");
    const id = parseInt(idLine.substring(5), 10);
    c.sendData("version", 35);
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (v)");
    c.sendData("language", "en");
    c.sendData("logintype", "nr");
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (lt)");
    c.sendData("login");
    await c.waitFor((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
    return id;
}

async function waitClosed(c: Client, label: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!c.closed) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`[${c.name}] timeout waiting for close: ${label}`);
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

async function main(): Promise<void> {
    const running: RunningServer = await startServer({
        host: HOST,
        port: PORT,
        tracksDir: tracksDir(),
        verbose: false,
    });

    try {
        const c = new Client("A");
        await c.open();
        const playerId = await login(c);

        // Burn a few DATA seq numbers to mimic an in-progress game session.
        for (let i = 0; i < 5; i++) {
            c.sendData("lobbyselect", "select", "x");
        }

        c.terminate();
        await new Promise((r) => setTimeout(r, 150));

        const stale = new Client("stale");
        await stale.open();
        await stale.waitFor((s) => s === "c ctr", "c ctr");
        // Buggy client: game loop fires cursor on the fresh socket before c old.
        stale.outSeq = 5;
        stale.sendData("game", "cursor", 10, 20);
        await waitClosed(stale, "stale-seq socket closed by server");

        const clean = new Client("clean");
        await clean.open();
        await clean.waitFor((s) => s === "c ctr", "c ctr");
        clean.sendCommand("old", String(playerId));
        await clean.waitFor((s) => s === "c rcok", "c rcok");
        clean.sendData("lobbyselect", "select", "x");
        await new Promise((r) => setTimeout(r, 100));
        if (clean.closed) {
            throw new Error("post-rcok DATA at seq 0 should be accepted; socket closed");
        }

        clean.terminate();
        console.log("[OK] stale outSeq before handshake trips seq-mismatch; clean handshake survives");
    } finally {
        await running.close();
    }
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
