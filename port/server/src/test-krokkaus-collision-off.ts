// Regression: cmpt collision=0 must stay off (krokkaus disabled).
//
// Pre-fix: `parseInt(rest[8] ?? "1", 10) || 1` treated 0 as falsy and
// coerced collision off → on. Rooms created with krokkaus disabled were
// stored and broadcast as collision=1, enabling ball-vs-ball physics the
// host explicitly turned off.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-krokkaus-collision-off.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4255;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

class Client {
    name: string;
    ws: WebSocket;
    outSeq = 0;
    received: string[] = [];

    constructor(name: string) {
        this.name = name;
        this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        this.ws.on("message", (m) => this.received.push(m.toString()));
    }
    async open(): Promise<void> {
        await new Promise<void>((r) => this.ws.once("open", () => r()));
    }
    sendData(...fields: (string | number)[]): void {
        this.ws.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }
    sendCommand(verb: string, ...args: string[]): void {
        this.ws.send(`c ${[verb, ...args].join(" ")}`);
    }
    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 4000): Promise<string> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                console.log(`[${this.name}] timed out waiting for ${label}; queue:`, this.received);
                reject(new Error(`[${this.name}] timeout: ${label}`));
            }, timeoutMs);
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
    close(): void {
        try { this.ws.close(); } catch { /* */ }
    }
}

async function login(c: Client): Promise<void> {
    await c.waitFor((s) => s === "h 1", "h 1");
    await c.waitFor((s) => s.startsWith("c crt"), "c crt");
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("new");
    await c.waitFor((s) => s.startsWith("c id "), "c id");
    c.sendData("version", 35);
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (v)");
    c.sendData("language", "en");
    c.sendData("logintype", "nr");
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (lt)");
    c.sendData("login");
    await c.waitFor((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
}

async function enterMulti(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

/** gameinfo collision field index after the `d N game gameinfo` prefix. */
function gameinfoCollisionField(line: string): string {
    const parts = line.split("\t");
    return parts[11] ?? "";
}

/** gamelist add collision field index after `d N lobby gamelist add`. */
function gamelistCollisionField(line: string): string {
    const parts = line.split("\t");
    return parts[14] ?? "";
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });

        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        await login(a);
        await login(b);
        await enterMulti(a);
        await enterMulti(b);

        // collision=0 (krokkaus off) — the 9th cmpt arg after trackType.
        a.sendData("lobby", "cmpt", "NoKrok", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
        const addCollision = gamelistCollisionField(addLine);
        if (addCollision !== "0") {
            throw new Error(`gamelist add collision=${addCollision}; want 0 (krokkaus off)`);
        }
        console.log("[OK] gamelist add carries collision=0");

        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        const giCollision = gameinfoCollisionField(gi);
        if (giCollision !== "0") {
            throw new Error(`gameinfo collision=${giCollision}; want 0 (krokkaus off)`);
        }
        console.log("[OK] gameinfo carries collision=0");

        a.close();
        b.close();
        console.log("\nALL KROKKAUS-COLLISION-OFF CHECKS PASSED");
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    } finally {
        if (server) {
            try { await server.close(); } catch { /* */ }
        }
    }
}

main();
