// Regression: lobby `cmpt` must preserve collision=0 (krokkaus off).
//
// A prior bug used `parseInt(...) || 1`, which coerced collision=0 to 1
// because 0 is falsy in JavaScript. Rooms created with krokkaus disabled
// were stored and broadcast as collision on, so clients simulated ball-vs-ball
// collisions the host did not intend.
//
// Boots a fresh GolfServer on port 4254, walks two clients through guest
// login → multi lobby → create (collision=0) + join, then asserts:
//   1. `gamelist add` carries collision=0
//   2. `gameinfo` carries collision=0
//
// Usage: node --experimental-strip-types --no-warnings src/test-krokkaus-collision.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4254;
const HOST = "127.0.0.1";

/** Tab index of collision in `lobby gamelist add` (waterEvent is 13). */
const GAMELIST_COLLISION_IDX = 14;
/** Tab index of collision in `game gameinfo` (waterEvent is 10). */
const GAMEINFO_COLLISION_IDX = 11;

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
    send(line: string): void {
        this.ws.send(line);
    }
    sendData(...fields: (string | number)[]): void {
        this.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }
    sendCommand(verb: string, ...args: string[]): void {
        this.send(`c ${[verb, ...args].join(" ")}`);
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
        try {
            this.ws.close();
        } catch {
            /* */
        }
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

async function enterMultiLobby(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tusers/.test(s), "lobby users");
    await c.waitFor((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

function assertCollisionField(line: string, idx: number, expected: string, label: string): void {
    const fields = line.split("\t");
    const actual = fields[idx];
    if (actual !== expected) {
        throw new Error(`expected ${label} collision=${expected} at tab[${idx}] but got ${JSON.stringify(actual)} in ${line}`);
    }
    console.log(`[OK] ${label} collision=${expected}`);
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up");

        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);
        console.log("[OK] both in multi lobby");

        // collision=0 (krokkaus off). The old `|| 1` bug would store 1 here.
        a.sendData("lobby", "cmpt", "NoKrok", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B sees gamelist add");
        assertCollisionField(addLine, GAMELIST_COLLISION_IDX, "0", "gamelist add");

        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        assertCollisionField(gi, GAMEINFO_COLLISION_IDX, "0", "gameinfo");

        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack");
        console.log("[OK] both joined and started");

        a.close();
        b.close();
        console.log("\nPASS: krokkaus collision=0 preserved through lobby and stroke path");
    } catch (err) {
        console.error("FAIL:", err);
        process.exitCode = 1;
    } finally {
        await server?.close();
    }
}

main();
