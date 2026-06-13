// Regression tests for mid-game disconnect grace + reconnect resync (PR #63).
//
// Pre-fix: in-game disconnects called fullyRemovePlayer immediately, so a
// brief network blip cost the player their seat and left peers blocked on
// the disconnected player's 'f' slot until the room gave up.
//
// Post-fix:
//   - Mid-game drops get the same 250s grace window as lobby players.
//   - handlePlayerDisconnect synthesizes an endstroke 'p' on the current hole.
//   - allDoneOnCurrentTrack / nextTrack treat grace-period 'f' slots as
//     skippable and cap missed holes at maxStrokes so going offline can't
//     score zero across the match.
//   - handleReconnect replays resetvoteskip/starttrack (+ gametrack past hole 1)
//     catchup so the client resyncs after a blip.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-midgame-reconnect.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

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
    port: number;

    constructor(name: string, port: number) {
        this.name = name;
        this.port = port;
        this.ws = new WebSocket(`ws://${HOST}:${port}/ws`);
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
    hardDisconnect(): void {
        this.ws.terminate();
    }
    close(): void {
        try { this.ws.close(); } catch { /* */ }
    }
}

async function login(c: Client): Promise<number> {
    await c.waitFor((s) => s === "h 1", "h 1");
    await c.waitFor((s) => s.startsWith("c crt"), "c crt");
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("new");
    const idLine = await c.waitFor((s) => s.startsWith("c id "), "c id");
    const playerId = parseInt(idLine.substring(5), 10);
    c.sendData("version", 35);
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (v)");
    c.sendData("language", "en");
    c.sendData("logintype", "nr");
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (lt)");
    c.sendData("login");
    await c.waitFor((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
    return playerId;
}

async function enterMulti(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

async function reconnectViaOld(name: string, port: number, playerId: number): Promise<Client> {
    const c = new Client(name, port);
    await c.open();
    await c.waitFor((s) => s === "h 1", "h 1");
    await c.waitFor((s) => s.startsWith("c crt"), "c crt");
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("old", String(playerId));
    await c.waitFor((s) => s === "c rcok", "c rcok");
    return c;
}

async function startTwoPlayerGame(a: Client, b: Client): Promise<string> {
    a.sendData("lobby", "cmpt", "MidReconnect", "-", 0, 2, 2, 1, 3, 60, 0, 1, 0, 0);
    const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
    const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
    b.sendData("lobby", "jmpt", String(gameId));
    await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
    await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
    const t1 = await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack 1");
    await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack 1");
    return t1;
}

const ENC = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
const MOUSE = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");

/** Scenario 1: reconnect catchup while the match is still in progress. */
async function testReconnectCatchup(port: number): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port, tracksDir: tracksDir(), verbose: false });
        console.log("\n[scenario 1] reconnect catchup on hole 2");

        const a = new Client("A", port);
        const b = new Client("B", port);
        await Promise.all([a.open(), b.open()]);

        const bPlayerId = await login(b);
        await login(a);
        await enterMulti(a);
        await enterMulti(b);

        const t1 = await startTwoPlayerGame(a, b);

        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A sees own stroke");
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "B sees A's stroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "B sees A holed");

        b.hardDisconnect();
        await new Promise((r) => setTimeout(r, 150));
        await a.waitFor(
            (s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s),
            "A sees B's disconnect forfeit on hole 1",
        );
        await a.waitFor(
            (s) => /^d \d+ game\tstarttrack/.test(s) && s !== t1,
            "A starttrack 2 after B forfeit",
        );

        const b2 = await reconnectViaOld("B-recon", port, bPlayerId);
        // Catchup must NOT include `game start` — that packet wipes in-memory
        // hole scores on a reconnecting client. Late joiners need it; reconnects don't.
        await b2.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), "B catchup resetvoteskip");
        const catchupTrack = await b2.waitFor(
            (s) => /^d \d+ game\tstarttrack\tff/.test(s),
            "B catchup starttrack on hole 2",
        );
        if (!catchupTrack.includes("\tE ")) {
            throw new Error(`reconnect starttrack missing elapsed field E: ${catchupTrack}`);
        }

        b2.sendData("game", "cursor", 10, 20);
        await a.waitFor(
            (s) => /^d \d+ game\tcursor\t1\t10\t20$/.test(s),
            "A sees B's post-reconnect cursor",
        );

        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A stroke hole 2");
        await b2.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "B sees A stroke hole 2");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed hole 2");
        await b2.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "B sees A holed hole 2");

        b2.sendData("game", "forfeit");
        await b2.waitFor((s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s), "B forfeit hole 2");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s), "A sees B forfeit hole 2");
        await a.waitFor((s) => /^d \d+ game\tend$/.test(s), "A game end");
        await b2.waitFor((s) => /^d \d+ game\tend$/.test(s), "B game end");

        a.close();
        b2.close();
        console.log("[OK] scenario 1 passed");
    } finally {
        if (server) {
            try { await server.close(); } catch { /* */ }
        }
    }
}

/** Scenario 2: offline player gets maxStrokes on a missed hole, not zero. */
async function testOfflineScoreCap(port: number): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port, tracksDir: tracksDir(), verbose: false });
        console.log("\n[scenario 2] offline score cap on missed hole");

        const a = new Client("A", port);
        const b = new Client("B", port);
        await Promise.all([a.open(), b.open()]);

        await login(b);
        await login(a);
        await enterMulti(a);
        await enterMulti(b);

        const t1 = await startTwoPlayerGame(a, b);

        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A sees own stroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed");

        b.hardDisconnect();
        await new Promise((r) => setTimeout(r, 150));
        await a.waitFor(
            (s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s),
            "A sees B's disconnect forfeit on hole 1",
        );
        await a.waitFor(
            (s) => /^d \d+ game\tstarttrack/.test(s) && s !== t1,
            "A starttrack 2",
        );

        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A stroke hole 2");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed hole 2");
        await a.waitFor(
            (s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s),
            "A sees B capped at maxStrokes on missed hole 2",
        );
        await a.waitFor((s) => /^d \d+ game\tend$/.test(s), "A game end");

        a.close();
        console.log("[OK] scenario 2 passed");
    } finally {
        if (server) {
            try { await server.close(); } catch { /* */ }
        }
    }
}

async function main(): Promise<void> {
    try {
        await testReconnectCatchup(4250);
        await testOfflineScoreCap(4251);
        console.log("\nALL MID-GAME RECONNECT PHASES PASSED");
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    }
}

main();
