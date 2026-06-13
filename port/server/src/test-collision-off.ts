// Regression: cmpt lobby must preserve collision=0 (krokkaus off).
//
// Pre-fix: `parseInt(rest[8] ?? "1", 10) || 1` coerced 0 to 1 because 0 is
// falsy in JavaScript. Rooms created with krokkaus disabled were stored and
// broadcast as collision on, so clients still ran ball-vs-ball physics and
// applied apply_tick lookahead.
//
// Post-fix: collision is validated as 0 or 1 without `|| 1`. This test
// asserts gameinfo carries collision=0 and beginstroke omits krokkaus
// lookahead (apply_tick stays at the elapsed world tick).
//
// Usage: node --experimental-strip-types --no-warnings src/test-collision-off.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { MultiGame } from "./game.ts";
import { TrackManager } from "./tracks.ts";
import { Player } from "./player.ts";
import type { Connection } from "./connection.ts";
import { GolfServer } from "./server.ts";
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

function gameinfoCollision(pkt: string): string {
    // d <seq> game\tgameinfo\t... collision is field [11] (0-indexed tab split).
    const fields = pkt.split("\t");
    return fields[11] ?? "";
}

async function assertLookaheadTicksZero(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    const mockConn = {
        sendDataRaw: () => {},
        sendData: () => {},
    } as unknown as Connection;
    const server = new GolfServer(tm);
    const creator = new Player(mockConn, 1);
    server.addPlayer(creator);

    const game = new MultiGame(
        creator,
        42,
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
        throw new Error(`collision-off getStrokeLookaheadTicks()=${lookahead}; want 0`);
    }
    console.log("[OK] collision-off games skip krokkaus lookahead ticks");
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

        a.sendData("lobbyselect", "select", "x");
        await a.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "A gamelist full");
        b.sendData("lobbyselect", "select", "x");
        await b.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "B gamelist full");

        // collision=0 (krokkaus off). Pre-fix this was stored as 1.
        a.sendData("lobby", "cmpt", "NoKrokkaus", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));

        const aGi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        const bGi = await b.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "B gameinfo");
        const collisionA = gameinfoCollision(aGi);
        const collisionB = gameinfoCollision(bGi);
        if (collisionA !== "0" || collisionB !== "0") {
            throw new Error(
                `gameinfo collision must be 0 (krokkaus off); got A=${collisionA} B=${collisionB}. ` +
                    `Pre-fix bug: parseInt(...) || 1 coerced 0 to 1.`,
            );
        }
        console.log("[OK] gameinfo carries collision=0 for both players");

        await assertLookaheadTicksZero();

        a.close();
        b.close();
        console.log("\nCOLLISION-OFF REGRESSION PASSED");
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    } finally {
        if (server) {
            try {
                await server.close();
            } catch {
                /* */
            }
        }
    }
}

main();
