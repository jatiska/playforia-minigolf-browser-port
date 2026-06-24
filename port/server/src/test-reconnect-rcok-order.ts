// Regression: `c rcok` must arrive before the first catchup DATA packet.
//
// The web client validates inbound DATA seq against a stale inSeq until
// `c rcok` resets both counters to 0. If catchup DATA lands first the client
// drops the socket (seq mismatch) and the reconnect fails.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-reconnect-rcok-order.ts

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
    /** Full append-only log — never spliced so message order is preserved. */
    readonly log: string[] = [];
    received: string[] = [];

    constructor(name: string) {
        this.name = name;
        this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        this.ws.on("message", (m) => {
            const line = m.toString();
            this.log.push(line);
            this.received.push(line);
        });
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

    terminate(): void {
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

async function enterMulti(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

async function main(): Promise<void> {
    const running: RunningServer = await startServer({
        host: HOST,
        port: PORT,
        tracksDir: tracksDir(),
        verbose: false,
    });

    try {
        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);

        const playerId = await login(a);
        await login(b);
        await enterMulti(a);
        await enterMulti(b);

        a.sendData("lobby", "cmpt", "RcokOrder", "-", 0, 2, 2, 1, 3, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack");

        a.terminate();
        await new Promise((r) => setTimeout(r, 150));

        const a2 = new Client("A2");
        await a2.open();
        await a2.waitFor((s) => s === "h 1", "h 1");
        await a2.waitFor((s) => s.startsWith("c crt"), "c crt");
        await a2.waitFor((s) => s === "c ctr", "c ctr");

        const oldSentAt = a2.log.length;
        a2.sendCommand("old", String(playerId));

        await a2.waitFor((s) => s === "c rcok", "c rcok");
        await a2.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), "catchup DATA");

        const burst = a2.log.slice(oldSentAt);
        const rcokIdx = burst.indexOf("c rcok");
        const firstDataIdx = burst.findIndex((s) => /^d \d+ /.test(s));

        if (rcokIdx < 0) {
            throw new Error("burst missing c rcok");
        }
        if (firstDataIdx < 0) {
            throw new Error("burst missing catchup DATA");
        }
        if (rcokIdx >= firstDataIdx) {
            throw new Error(
                `c rcok must precede catchup DATA (rcok@${rcokIdx}, data@${firstDataIdx}): ${JSON.stringify(burst.slice(0, 6))}`,
            );
        }

        const firstData = burst[firstDataIdx];
        if (!/^d 0 /.test(firstData)) {
            throw new Error(`first catchup DATA should be seq 0 after rcok reset, got: ${firstData}`);
        }

        console.log("[OK] c rcok precedes catchup DATA and first DATA seq is 0");

        a2.close();
        b.close();
        console.log("\nALL RCOK ORDER PHASES PASSED");
    } finally {
        await running.close();
    }
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
