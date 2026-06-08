// Smoke test: mid-game reconnect via `c old <id>` after an abrupt socket drop.
//
// Uses a 2-player practice session so the game survives one player's blip.
// 1. Two clients enter multi lobby; A creates a 4-seat room, B joins.
// 2. A starts practice → both receive starttrack.
// 3. A's socket is terminated abruptly.
// 4. A reconnects with `c old <id>` → `c rcok` + catchup burst.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-reconnect-ingame.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4249;
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

    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 5000): Promise<string> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                reject(new Error(`[${this.name}] timeout: ${label}; queue=${JSON.stringify(this.received.slice(0, 8))}`));
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

    drain(): void {
        this.received.length = 0;
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

async function enterMultiLobby(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tusers/.test(s), "lobby users");
    await c.waitFor((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

async function run(): Promise<void> {
    const running: RunningServer = await startServer({
        host: HOST,
        port: PORT,
        tracksDir: tracksDir(),
        verbose: false,
    });

    let exitCode = 0;
    try {
        console.log("Phase 1: two clients enter multi lobby and start practice");
        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        const playerId = await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);

        a.sendData("lobby", "cmpt", "ReconnectRoom", "-", 0, 4, 3, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tjoin\t2\t/.test(s), "A sees B join");

        a.drain();
        b.drain();
        a.sendData("game", "practice");
        for (const cli of [a, b]) {
            await cli.waitFor((s) => /^d \d+ game\tstart$/.test(s), `${cli.name} game start`);
            await cli.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), `${cli.name} resetvoteskip`);
            await cli.waitFor((s) => /^d \d+ game\tstarttrack\tff\t/.test(s), `${cli.name} starttrack`, 8000);
        }
        console.log("  ok: practice running, A id =", playerId);

        console.log("\nPhase 2: drop A's socket abruptly");
        a.terminate();
        await new Promise((r) => setTimeout(r, 150));

        console.log("\nPhase 3: A reconnects with `c old` and expects catchup");
        const a2 = new Client("A2");
        await a2.open();
        await a2.waitFor((s) => s === "h 1", "h 1 (post-blip)");
        await a2.waitFor((s) => s.startsWith("c crt"), "crt (post-blip)");
        await a2.waitFor((s) => s === "c ctr", "ctr (post-blip)");
        a2.sendCommand("old", String(playerId));
        const rc = await a2.waitFor((s) => s.startsWith("c rc"), "rcok/rcf");
        if (rc !== "c rcok") {
            throw new Error(`expected c rcok but got ${rc}`);
        }
        console.log("  ok: c rcok");

        await a2.waitFor((s) => /^d \d+ game\tstart$/.test(s), "catchup game start");
        await a2.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), "catchup resetvoteskip");
        await a2.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "catchup starttrack", 8000);
        console.log("  ok: catchup burst received");

        a2.ws.close();
        b.ws.close();
        console.log("\nALL PHASES PASSED");
    } catch (err) {
        console.error("\nFAIL:", err instanceof Error ? err.message : err);
        exitCode = 1;
    } finally {
        await running.close();
    }
    process.exit(exitCode);
}

run().catch((err) => {
    console.error("fatal:", err);
    process.exit(2);
});
