// Regression: lobby cmpt must honour collision=0 (krokkaus off).
//
// Pre-fix: `parseInt(rest[8]) || 1` coerced 0 to 1 because 0 is falsy, so
// rooms created with krokkaus disabled were stored and broadcast as on.
// Post-fix: collision is validated as 0 or 1 explicitly.
//
// Also verifies collision-off games skip apply_tick lookahead (each ball is
// independent) while collision-on games add MIN_LOOKAHEAD_TICKS.
//
// Usage: node --experimental-strip-types --no-warnings src/test-collision-off.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { MIN_LOOKAHEAD_TICKS, MultiGame } from "./game.ts";
import { startServer, type RunningServer } from "./main.ts";
import { TrackManager } from "./tracks.ts";
import { Player } from "./player.ts";
import type { Connection } from "./connection.ts";
import { GolfServer } from "./server.ts";

const PORT = 4255;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

/** Field index of `collision` in getGameString (gameId is field 0). */
const COLLISION_FIELD = 11;

function collisionFromGamelistAdd(line: string): number {
    const fields = line.split("\t").slice(3);
    return parseInt(fields[COLLISION_FIELD] ?? "-1", 10);
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
                console.log(`[${this.name}] timed out: ${label}; queue:`, this.received);
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

async function testLobbyCollisionParsing(): Promise<void> {
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

        // collision=0 (krokkaus off) — the 9th cmpt arg after water.
        a.sendData("lobby", "cmpt", "NoKrokkaus", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addOff = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "gamelist add (off)");
        const collisionOff = collisionFromGamelistAdd(addOff);
        if (collisionOff !== 0) {
            throw new Error(
                `gamelist add collision=${collisionOff}; want 0. ` +
                `Pre-fix bug: parseInt("0") || 1 stored krokkaus as on.`,
            );
        }
        console.log("[OK] gamelist add honours collision=0");

        const gameId = parseInt(addOff.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack");

        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouse = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouse);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "collision-off stroke broadcast");
        console.log("[OK] collision-off game accepts strokes");

        a.close();
        b.close();
    } finally {
        if (server) {
            try { await server.close(); } catch { /* */ }
        }
    }
}

async function testLookaheadTicksDirect(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());

    const mockConn = {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
    } as unknown as Connection;

    const server = new GolfServer(tm);
    const creator = new Player(mockConn, 1);
    server.addPlayer(creator);

    const gameOff = new MultiGame(
        creator,
        100,
        "UnitOff",
        "-",
        1,
        0,
        0,
        10,
        60,
        0,
        0,
        0,
        0,
        2,
        tm,
        false,
    );
    const gameOn = new MultiGame(
        creator,
        101,
        "UnitOn",
        "-",
        1,
        0,
        0,
        10,
        60,
        0,
        1,
        0,
        0,
        2,
        tm,
        false,
    );

    const lookaheadOff = (gameOff as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const lookaheadOn = (gameOn as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();

    if (lookaheadOff !== 0) {
        throw new Error(`collision=0 lookahead=${lookaheadOff}; want 0`);
    }
    if (lookaheadOn < MIN_LOOKAHEAD_TICKS) {
        throw new Error(`collision=1 lookahead=${lookaheadOn}; want >= ${MIN_LOOKAHEAD_TICKS}`);
    }
    console.log("[OK] getStrokeLookaheadTicks: 0 when off, >=MIN when on");
}

async function main(): Promise<void> {
    try {
        await testLookaheadTicksDirect();
        await testLobbyCollisionParsing();
        console.log("\nALL COLLISION-OFF REGRESSIONS PASSED");
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    }
}

main();
