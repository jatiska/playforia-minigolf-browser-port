// Regression test: krokkaus (ball-vs-ball collision) lobby setting.
//
// PR #4 fixed `cmpt` parsing coercing collision=0 to 1 via `parseInt(...) || 1`.
// Without the fix, rooms created with krokkaus off were stored and broadcast
// as collision on, and strokes still used adaptive apply_tick lookahead.
//
// Verifies:
//   1. collision=0 survives cmpt parsing into gamelist + gameinfo.
//   2. collision=0 games emit apply_tick with zero lookahead (no ping buffer).
//   3. Invalid collision values still default to 1.
//
// Usage: node --experimental-strip-types --no-warnings src/test-krokkaus-collision.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4254;
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

async function enterMultiLobby(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tusers/.test(s), "lobby users");
    await c.waitFor((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

/** gameinfo: ... waterEvent [10], collision [11], ... */
function collisionFromGameinfo(line: string): string {
    return line.split("\t")[11] ?? "";
}

/** gamelist add gameString: collision is field index 14 after `d N lobby gamelist add`. */
function collisionFromGamelistAdd(line: string): string {
    return line.split("\t")[14] ?? "";
}

async function testCollisionOff(): Promise<void> {
    const a = new Client("A-off");
    const b = new Client("B-off");
    await Promise.all([a.open(), b.open()]);
    try {
        await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);

        // collision=0 (krokkaus off).
        a.sendData("lobby", "cmpt", "NoKrokkaus", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "gamelist add");
        const collisionInList = collisionFromGamelistAdd(addLine);
        if (collisionInList !== "0") {
            throw new Error(`gamelist add collision=${collisionInList}; want 0 (pre-fix coerced to 1): ${addLine}`);
        }
        console.log("[OK] gamelist add carries collision=0");

        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "gameinfo");
        const collisionInInfo = collisionFromGameinfo(gi);
        if (collisionInInfo !== "0") {
            throw new Error(`gameinfo collision=${collisionInInfo}; want 0: ${gi}`);
        }
        console.log("[OK] gameinfo carries collision=0");

        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "game start");
        const startTrack = await a.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "B starttrack");

        const elapsedField = startTrack.split("\t").find((f) => f.startsWith("E "));
        const elapsedMs = elapsedField ? parseInt(elapsedField.slice(2), 10) : 0;
        const baseTick = Math.floor(elapsedMs / 6);

        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouse = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouse);
        const stroke = await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "beginstroke");
        const applyTick = parseInt(stroke.split("\t")[6] ?? "", 10);
        if (!Number.isFinite(applyTick)) {
            throw new Error(`apply_tick missing from beginstroke: ${stroke}`);
        }
        // collision=0 skips ping lookahead; allow a couple ticks of drift between
        // starttrack and the stroke packet arriving.
        if (applyTick < baseTick || applyTick > baseTick + 3) {
            throw new Error(
                `collision=0 should use zero lookahead (apply_tick=${applyTick}, base=${baseTick}): ${stroke}`,
            );
        }
        console.log(`[OK] collision=0 stroke uses zero lookahead apply_tick=${applyTick}`);
    } finally {
        a.close();
        b.close();
    }
}

async function testInvalidCollisionDefaultsOn(): Promise<void> {
    const a = new Client("A-bad");
    const b = new Client("B-bad");
    await Promise.all([a.open(), b.open()]);
    try {
        await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);

        // collision=2 is invalid; server should clamp to 1.
        a.sendData("lobby", "cmpt", "BadCollision", "-", 0, 2, 1, 0, 10, 60, 0, 2, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "gamelist add (invalid)");
        if (collisionFromGamelistAdd(addLine) !== "1") {
            throw new Error(`invalid collision should default to 1: ${addLine}`);
        }
        console.log("[OK] invalid collision value defaults to 1");
    } finally {
        a.close();
        b.close();
    }
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up on", PORT);
        await testCollisionOff();
        await testInvalidCollisionDefaultsOn();
        console.log("\nALL OK");
    } finally {
        server?.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
