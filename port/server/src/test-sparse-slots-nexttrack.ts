// Regression: mid-game leaver must not shrink playStatus on nextTrack.
//
// Scenario: 4-player MultiGame fills (slots 0..3). Player in slot 1 leaves
// mid-hole; survivors keep sparse ids 0, 2, 3. When the hole completes and
// `nextTrack` broadcasts the next `starttrack`, playStatus must stay width 4
// (numPlayers), not 3 (players.length). Otherwise slot 3's beginstroke gate
// (`playStatus.charAt(3) === 'f'`) silently rejects every shot on hole 2+.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-sparse-slots-nexttrack.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4250;
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
    drain(predicate: (s: string) => boolean): string[] {
        const out: string[] = [];
        const keep: string[] = [];
        for (const s of this.received) {
            if (predicate(s)) out.push(s);
            else keep.push(s);
        }
        this.received = keep;
        return out;
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

function ownInfoSlot(line: string): number {
    const m = line.match(/game\towninfo\t(-?\d+)/);
    if (!m) throw new Error(`not an owninfo: ${line}`);
    return parseInt(m[1], 10);
}

const ENC = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
const MOUSE = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up");

        const a = new Client("A");
        const b = new Client("B");
        const c = new Client("C");
        const d = new Client("D");
        await Promise.all([a.open(), b.open(), c.open(), d.open()]);
        for (const client of [a, b, c, d]) await login(client);
        for (const client of [a, b, c, d]) await enterMultiLobby(client);
        console.log("[OK] A-D in multi lobby");

        // 4-player room, 3 tracks, unlimited strokes.
        a.sendData("lobby", "cmpt", "SparseNext", "-", 0, 4, 3, 0, 0, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);

        b.sendData("lobby", "jmpt", String(gameId));
        c.sendData("lobby", "jmpt", String(gameId));
        d.sendData("lobby", "jmpt", String(gameId));

        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        for (const client of [b, c, d]) {
            await client.waitFor((s) => /^d \d+ game\tstart$/.test(s), `${client.name} game start`);
        }
        const track1 = await a.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "A starttrack hole 1");
        const playStatusWidth = (line: string): number => {
            const m = line.match(/game\tstarttrack\t(\w+)\t/);
            return m?.[1]?.length ?? 0;
        };
        if (playStatusWidth(track1) !== 4) {
            throw new Error(`expected 4-wide playStatus on hole 1, got: ${track1}`);
        }

        const aOwn = await a.waitFor((s) => /game\towninfo/.test(s), "A owninfo");
        const bOwn = await b.waitFor((s) => /game\towninfo/.test(s), "B owninfo");
        const cOwn = await c.waitFor((s) => /game\towninfo/.test(s), "C owninfo");
        const dOwn = await d.waitFor((s) => /game\towninfo/.test(s), "D owninfo");
        if (ownInfoSlot(aOwn) !== 0 || ownInfoSlot(bOwn) !== 1 ||
            ownInfoSlot(cOwn) !== 2 || ownInfoSlot(dOwn) !== 3) {
            throw new Error(
                `expected slots 0,1,2,3 got ${ownInfoSlot(aOwn)},${ownInfoSlot(bOwn)},` +
                `${ownInfoSlot(cOwn)},${ownInfoSlot(dOwn)}`,
            );
        }
        console.log("[OK] 4-player game started with slots 0..3");

        // B (slot 1) leaves mid-hole. Slot 1 is stamped 'p' for survivors.
        b.sendData("game", "back");
        await a.waitFor((s) => /game\tpart\t1\t4/.test(s), "A sees B part");
        console.log("[OK] B left mid-hole; survivors at sparse ids 0,2,3");

        // Finish hole 1: A holes in, C and D forfeit.
        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A beginstroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed");

        c.sendData("game", "forfeit");
        await c.waitFor((s) => /^d \d+ game\tendstroke\t2\t/.test(s), "C forfeit");
        d.sendData("game", "forfeit");
        await d.waitFor((s) => /^d \d+ game\tendstroke\t3\t/.test(s), "D forfeit");

        // Hole 2 starttrack must keep 4-wide playStatus, not shrink to 3.
        const track2 = await d.waitFor(
            (s) => /^d \d+ game\tstarttrack\t/.test(s) && playStatusWidth(s) === 4 && s !== track1,
            "D starttrack hole 2",
        );
        if (playStatusWidth(track2) !== 4) {
            throw new Error(
                `nextTrack shrunk playStatus to width ${playStatusWidth(track2)}; ` +
                "expected 4 (numPlayers) so slot 3 can shoot",
            );
        }
        console.log("[OK] hole 2 starttrack kept 4-wide playStatus after mid-game leaver");

        // Slot 3 (D) must be able to shoot on hole 2.
        d.sendData("game", "beginstroke", ENC, MOUSE);
        await d.waitFor((s) => /^d \d+ game\tbeginstroke\t3\t/.test(s), "D beginstroke on hole 2");
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t3\t/.test(s), "A sees D beginstroke on hole 2");
        console.log("[OK] slot-3 survivor can shoot after nextTrack");

        for (const client of [a, c, d]) client.close();
        console.log("\nALL SPARSE-SLOTS-NEXTTRACK PHASES PASSED");
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
