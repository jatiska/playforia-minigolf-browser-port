// Regression: lobby `cmpt` must preserve collision=0 (krokkaus off).
//
// Pre-fix: `parseInt(rest[8] ?? "1", 10) || 1` coerced 0 to 1 because 0 is
// falsy in JavaScript. Rooms created with krokkaus disabled were stored and
// broadcast as collision on, changing physics (ball-vs-ball) and apply_tick
// lookahead for every client.
//
// Post-fix: collision is parsed without `|| 1`; only NaN or values outside
// {0,1} fall back to 1. This test asserts both the gamelist row and the
// creator's gameinfo carry collision=0, and that collision-disabled games
// skip stroke lookahead.
//
// Usage: node --experimental-strip-types --no-warnings src/test-krokkaus-collision.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";
import { MultiGame } from "./game.ts";
import { TrackManager } from "./tracks.ts";
import { Player } from "./player.ts";
import type { Connection } from "./connection.ts";
import { GolfServer } from "./server.ts";

const PORT = 4254;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

/** Tab index of the collision field in a `lobby gamelist add` line. */
function gamelistCollisionIndex(parts: string[]): number {
    // add line: ... add <gameId> <name> <pwd> <perms> <numPlayers> <inProgress>
    //           <numTracks> <trackType> <maxStrokes> <strokeTimeout> <water> <collision>
    const addIdx = parts.indexOf("add");
    if (addIdx < 0) throw new Error("not a gamelist add line");
    return addIdx + 12;
}

/** Tab index of the collision field in a `game gameinfo` line. */
function gameinfoCollisionIndex(parts: string[]): number {
    const giIdx = parts.indexOf("gameinfo");
    if (giIdx < 0) throw new Error("not a gameinfo line");
    return giIdx + 10;
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

async function assertLookaheadZeroWhenCollisionOff(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    const mockConn = {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
        peakPingMs: 50,
    } as unknown as Connection;

    const server = new GolfServer(tm);
    const creator = new Player(mockConn, 1);
    server.addPlayer(creator);

    const game = new MultiGame(
        creator,
        1,
        "Unit",
        "-",
        3,
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

    const lookahead = (game as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    if (lookahead !== 0) {
        throw new Error(`collision=0 must skip lookahead; got ${lookahead}`);
    }
    console.log("[OK] collision=0 games skip apply_tick lookahead");
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        await assertLookaheadZeroWhenCollisionOff();

        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up");

        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);
        console.log("[OK] both players in multi lobby");

        // cmpt: ... <water=0> <collision=0> <scoring> <weightEnd>
        a.sendData("lobby", "cmpt", "NoKrok", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        const addParts = addLine.split("\t");
        const collisionIdx = gamelistCollisionIndex(addParts);
        if (addParts[collisionIdx] !== "0") {
            throw new Error(
                `expected gamelist collision=0 at index ${collisionIdx}; got ${addParts[collisionIdx]} in: ${addLine}`,
            );
        }
        console.log("[OK] gamelist add carries collision=0");

        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        const giParts = gi.split("\t");
        const giCollisionIdx = gameinfoCollisionIndex(giParts);
        if (giParts[giCollisionIdx] !== "0") {
            throw new Error(
                `expected gameinfo collision=0 at index ${giCollisionIdx}; got ${giParts[giCollisionIdx]} in: ${gi}`,
            );
        }
        console.log("[OK] gameinfo carries collision=0");

        console.log("\nALL CHECKS PASSED");
        a.close();
        b.close();
    } catch (err) {
        console.error("\nFAIL:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    } finally {
        await server?.close();
    }
    process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
    console.error("fatal:", err);
    process.exit(2);
});
