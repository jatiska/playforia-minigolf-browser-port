// Regression: krokkaus (ball-vs-ball collision) OFF must survive cmpt parsing.
//
// Pre-fix: the cmpt handler used `parseInt(rest[8]) || 1`, which coerced
// collision=0 to 1 because 0 is falsy in JavaScript. Rooms created with
// krokkaus disabled were stored and broadcast as collision on, forcing
// apply_tick lookahead and enabling peer collisions the lobby didn't want.
//
// Post-fix: collision 0 is preserved in gameinfo and beginstroke omits the
// krokkaus lookahead (apply_tick tracks the elapsed world tick only).
//
// Invoke: node --experimental-strip-types --no-warnings src/test-krokkaus-collision.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { MIN_LOOKAHEAD_TICKS, PHYSICS_STEP_MS } from "./game.ts";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4252;
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
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

/** Parse collision from `d N game\tgameinfo\t...` (field index 11 after verb). */
function collisionFromGameInfo(line: string): number {
    const f = line.split("\t");
    return parseInt(f[11] ?? "1", 10);
}

const ENC = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
const MOUSE = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");

/** Shoot immediately after starttrack and return the broadcast apply_tick. */
async function firstStrokeApplyTick(a: Client, b: Client): Promise<number> {
    await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "game start");
    await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "game start");
    await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "starttrack");
    await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "starttrack");
    a.sendData("game", "beginstroke", ENC, MOUSE);
    const stroke = await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "beginstroke broadcast");
    const applyTick = parseInt(stroke.split("\t")[6] ?? "", 10);
    if (!Number.isFinite(applyTick)) {
        throw new Error(`beginstroke missing apply_tick: ${stroke}`);
    }
    return applyTick;
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

        // collision=0 is the 9th cmpt arg after water (rest[8]).
        a.sendData("lobby", "cmpt", "NoKrok", "-", 0, 2, 1, 0, 10, 60, 0, 0, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);

        const aInfo = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        if (collisionFromGameInfo(aInfo) !== 0) {
            throw new Error(`creator gameinfo collision=${collisionFromGameInfo(aInfo)}; want 0`);
        }
        console.log("[OK] creator gameinfo carries collision=0");

        b.sendData("lobby", "jmpt", String(gameId));
        const bInfo = await b.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "B gameinfo");
        if (collisionFromGameInfo(bInfo) !== 0) {
            throw new Error(`joiner gameinfo collision=${collisionFromGameInfo(bInfo)}; want 0`);
        }
        console.log("[OK] joiner gameinfo carries collision=0");

        const applyOff = await firstStrokeApplyTick(a, b);
        console.log(`[OK] collision=0 first-stroke apply_tick=${applyOff}`);

        // Leave the krokkaus-off room and create a krokkaus-on twin so we can
        // compare apply_tick sizing on the same host without guessing elapsed ms.
        a.sendData("game", "back");
        b.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "A back in lobby");
        await b.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "B back in lobby");

        a.sendData("lobby", "cmpt", "KrokOn", "-", 0, 2, 1, 0, 10, 60, 0, 1, 0, 0);
        const addOn = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add (on)");
        const gameOnId = parseInt(addOn.split("\t")[3] ?? "0", 10);
        await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo (on)");
        b.sendData("lobby", "jmpt", String(gameOnId));
        const bInfoOn = await b.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "B gameinfo (on)");
        if (collisionFromGameInfo(bInfoOn) !== 1) {
            throw new Error(`krokkaus-on gameinfo collision=${collisionFromGameInfo(bInfoOn)}; want 1`);
        }

        const applyOn = await firstStrokeApplyTick(a, b);
        const extra = applyOn - applyOff;
        if (extra < MIN_LOOKAHEAD_TICKS) {
            throw new Error(
                `collision=1 apply_tick=${applyOn} only ${extra}t above collision=0 ` +
                    `apply_tick=${applyOff}; want >= ${MIN_LOOKAHEAD_TICKS}t krokkaus lookahead`,
            );
        }
        console.log(
            `[OK] collision=1 adds krokkaus lookahead (+${extra}t, ` +
                `${(extra * PHYSICS_STEP_MS).toFixed(0)}ms vs collision=0)`,
        );

        a.close();
        b.close();
        console.log("\nALL KROKKAUS-COLLISION PHASES PASSED");
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
