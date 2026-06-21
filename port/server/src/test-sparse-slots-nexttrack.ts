// Regression: after a mid-game leaver, nextTrack must not shrink playStatus to
// players.length. MultiGame keeps sparse slot ids (e.g. occupants at 0,2,3
// after slot 1 leaves). Pre-fix: nextTrack rebuilt playStatus with length 3,
// so slot 3's beginstroke gate saw charAt(3)==="" and silently rejected shots.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-sparse-slots-nexttrack.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const HOST = "127.0.0.1";
const PORT = 4252;

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
                reject(new Error(`[${this.name}] timeout: ${label}; queue=${JSON.stringify(this.received.slice(0, 10))}`));
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

const ENC = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
const MOUSE = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");

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
        const c = new Client("C");
        const d = new Client("D");
        await Promise.all([a.open(), b.open(), c.open(), d.open()]);
        await Promise.all([login(a), login(b), login(c), login(d)]);
        await Promise.all([enterMulti(a), enterMulti(b), enterMulti(c), enterMulti(d)]);

        a.sendData("lobby", "cmpt", "SparseNext", "-", 0, 4, 2, 1, 3, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "gamelist add");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        for (const cli of [b, c, d]) {
            cli.sendData("lobby", "jmpt", String(gameId));
        }
        for (const cli of [a, b, c, d]) {
            await cli.waitFor((s) => /^d \d+ game\tstart$/.test(s), `${cli.name} game start`);
            await cli.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), `${cli.name} starttrack 1`);
        }

        // B (slot 1) leaves mid-hole-1 → survivors keep sparse ids 0,2,3.
        b.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ game\tpart\t1\t/.test(s), "A sees B part (slot 1)");

        // Close hole 1 via forfeit so we don't depend on async holing order.
        for (const cli of [a, c, d]) {
            cli.sendData("game", "forfeit");
        }
        const track2 = await d.waitFor(
            (s) => /^d \d+ game\tstarttrack\t/.test(s),
            "hole 2 starttrack",
        );
        const playStatus = track2.split("\t")[2] ?? "";
        if (playStatus.length !== 4) {
            throw new Error(`hole-2 playStatus length=${playStatus.length}; want 4 (numPlayers cap)`);
        }
        if (playStatus.charAt(1) !== "p") {
            throw new Error(`vacant slot 1 should stay 'p'; got playStatus=${playStatus}`);
        }
        if (playStatus.charAt(3) !== "f") {
            throw new Error(`slot 3 should be playable 'f'; got playStatus=${playStatus}`);
        }

        d.sendData("game", "beginstroke", ENC, MOUSE);
        await d.waitFor((s) => /^d \d+ game\tbeginstroke\t3\t/.test(s), "D stroke hole 2");
        console.log("[OK] sparse slot 3 can shoot after leaver + nextTrack");

        for (const cli of [a, c, d]) cli.close();
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    } finally {
        try { await running.close(); } catch { /* */ }
    }
}

main();
