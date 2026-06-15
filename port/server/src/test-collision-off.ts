// Krokkaus-off (collision=0) smoke test.
//
// Regression for the cmpt handler bug where `parseInt(collision) || 1`
// coerced collision=0 to 1 (0 is falsy in JavaScript). Rooms created with
// krokkaus disabled were stored and broadcast as collision on, changing
// gameplay (ball-vs-ball hits) and adding apply_tick lookahead.
//
// Verifies:
//   1. `lobby cmpt ... collision=0` is preserved in the gamelist row.
//   2. `gameinfo` field [11] is collision=0 for the creator.
//   3. First beginstroke carries apply_tick with zero lookahead (no MIN
//      lookahead padding that collision=1 games always get).
//
// Usage: node --experimental-strip-types --no-warnings src/test-collision-off.ts

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

/** gameinfo field [11] is collision (see GolfGame.sendGameInfo). */
function gameInfoCollision(line: string): string {
    return line.split("\t")[11] ?? "";
}

/** getGameString collision is the 12th field; gamelist add prefixes 3 tabs. */
function gamelistCollision(line: string): string {
    return line.split("\t")[14] ?? "";
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

        // Create with collision=0 (krokkaus off). Pre-fix: stored as 1.
        a.sendData("lobby", "cmpt", "NoKrokkaus", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        const listCollision = gamelistCollision(addLine);
        if (listCollision !== "0") {
            throw new Error(`gamelist collision=${listCollision}; want 0 (cmpt collision=0 was coerced?)`);
        }
        console.log("[OK] gamelist row preserves collision=0");

        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        const infoCollision = gameInfoCollision(gi);
        if (infoCollision !== "0") {
            throw new Error(`gameinfo collision=${infoCollision}; want 0: ${gi}`);
        }
        console.log("[OK] gameinfo carries collision=0");

        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack");
        console.log("[OK] room filled and track started");

        // Behavioral check: collision-off skips MIN_LOOKAHEAD_TICKS padding.
        // Compare apply_tick against a collision-on room started at the same
        // phase (first stroke right after starttrack). The delta should be
        // at least MIN_LOOKAHEAD_TICKS (3); pre-fix both modes looked identical.
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        const strokeOff = await a.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t0\t/.test(s),
            "A sees own beginstroke (collision off)",
        );
        const applyOff = parseInt(strokeOff.split("\t")[6] ?? "-1", 10);
        if (!Number.isFinite(applyOff)) {
            throw new Error(`invalid apply_tick on collision-off stroke: ${strokeOff}`);
        }

        // Leave and spin up a collision-on control room with fresh clients.
        a.sendData("game", "back");
        b.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "A back to multi lobby");
        await b.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "B back to multi lobby");

        a.sendData("lobby", "cmpt", "KrokkausOn", "-", 0, 2, 1, 0, 10, 60, 0, 1, 0, 0);
        const addOn = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees collision-on gamelist add",
        );
        if (gamelistCollision(addOn) !== "1") {
            throw new Error(`control gamelist collision=${gamelistCollision(addOn)}; want 1`);
        }
        const gameIdOn = parseInt(addOn.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameIdOn));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game (on)");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start (on)");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start (on)");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack (on)");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack (on)");

        a.sendData("game", "beginstroke", ball, mouseA);
        const strokeOn = await a.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t0\t/.test(s),
            "A sees own beginstroke (collision on)",
        );
        const applyOn = parseInt(strokeOn.split("\t")[6] ?? "-1", 10);
        if (!Number.isFinite(applyOn)) {
            throw new Error(`invalid apply_tick on collision-on stroke: ${strokeOn}`);
        }

        const lookaheadDelta = applyOn - applyOff;
        if (lookaheadDelta < 3) {
            throw new Error(
                `collision-on/off apply_tick delta=${lookaheadDelta}; want >= 3 ` +
                    `(off=${applyOff}, on=${applyOn}). Pre-fix: collision=0 was stored as 1.`,
            );
        }
        console.log(`[OK] collision-off skips lookahead (apply_tick delta=${lookaheadDelta})`);

        a.close();
        b.close();
        console.log("\nALL COLLISION-OFF PHASES PASSED");
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
