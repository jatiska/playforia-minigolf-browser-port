// Regression: full desync-recovery cycle snapreq → snap → snapapply.
//
// `test-ballend-sparse-id.ts` only asserts snapreq fires after divergent
// ballend observations. This test completes the loop: both observers reply
// with agreeing snapshots, the resolver picks a winner, and all clients receive
// snapapply with a finite apply_tick and encoded ball blob.
//
// Also verifies disconnect-grace players are excluded from the observer quorum
// so recovery resolves without waiting for unreachable clients.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-snap-recovery.ts

import * as path from "node:path";
import {
    encodeBallSnapshot,
    SNAP_FLAG_STOPPED,
    type BallSnapshotEntry,
} from "@minigolf/shared";
import { MultiGame } from "./game.ts";
import { TrackManager } from "./tracks.ts";
import { Player } from "./player.ts";
import type { Connection } from "./connection.ts";
import { GolfServer } from "./server.ts";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

function mockConn(): Connection & { sent: string[] } {
    const sent: string[] = [];
    return {
        sendDataRaw: (body: string) => {
            sent.push(body);
        },
        sendData: (...fields: (string | number | boolean)[]) => {
            sent.push(fields.join("\t"));
        },
        sent,
        peakPingMs: 20,
    } as unknown as Connection & { sent: string[] };
}

function sampleSnapshot(): BallSnapshotEntry[] {
    return [
        {
            slot: 0,
            x: 100,
            y: 200,
            vx: 0,
            vy: 0,
            bounciness: 1,
            magnetMul: 1,
            flags: SNAP_FLAG_STOPPED,
            liquidTimer: 0,
            iterationsThisStroke: 120,
            downhillStuckCounter: 0,
            magnetStuckCounter: 0,
            spinningStuckCounter: 0,
            strokeStartX: 80,
            strokeStartY: 180,
            shoreX: 100,
            shoreY: 200,
            seedHex: "abc123",
        },
        {
            slot: 1,
            x: 150,
            y: 220,
            vx: 0,
            vy: 0,
            bounciness: 1,
            magnetMul: 1,
            flags: SNAP_FLAG_STOPPED,
            liquidTimer: 0,
            iterationsThisStroke: 95,
            downhillStuckCounter: 0,
            magnetStuckCounter: 0,
            spinningStuckCounter: 0,
            strokeStartX: 140,
            strokeStartY: 210,
            shoreX: 150,
            shoreY: 220,
            seedHex: "def456",
        },
    ];
}

function primeGameState(game: MultiGame): void {
    (game as unknown as { playStatus: string }).playStatus = "ff";
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
}

function parseSnapreqNonce(sent: string[]): number {
    const line = sent.find((s) => s.startsWith("game\tsnapreq\t"));
    if (!line) throw new Error(`no snapreq in: ${sent.join(" | ")}`);
    const nonce = parseInt(line.split("\t")[2] ?? "", 10);
    if (!Number.isFinite(nonce)) throw new Error(`bad snapreq line: ${line}`);
    return nonce;
}

function triggerDivergence(game: MultiGame, a: Player, b: Player, subjectId = 0): void {
    game.handlePacket(a, ["game", "ballend", "0", String(subjectId), "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "1", String(subjectId), "150.0", "200.0", "42"]);
}

async function assertFullRecoveryCycle(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());

    const server = new GolfServer(tm);
    const aConn = mockConn();
    const bConn = mockConn();
    const a = new Player(aConn, 1);
    const b = new Player(bConn, 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        92,
        "SnapRecovery",
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
    if (!game.addPlayerWithPassword(b, "-")) {
        throw new Error("failed to add player B");
    }
    a.game = game;
    b.game = game;
    primeGameState(game);

    triggerDivergence(game, a, b);

    const allSent = (): string[] => [...aConn.sent, ...bConn.sent];
    const nonce = parseSnapreqNonce(allSent());
    const blob = encodeBallSnapshot(sampleSnapshot());

    aConn.sent.length = 0;
    bConn.sent.length = 0;

    game.handlePacket(a, ["game", "snap", String(nonce), "0", "0", blob]);
    game.handlePacket(b, ["game", "snap", String(nonce), "1", "0", blob]);

    const snapapply = allSent().find((s) => s.startsWith("game\tsnapapply\t"));
    if (!snapapply) {
        throw new Error(`expected snapapply after agreeing snaps; got: ${allSent().join(" | ")}`);
    }
    const parts = snapapply.split("\t");
    const applyTick = parseInt(parts[2] ?? "", 10);
    const applyBlob = parts[3] ?? "";
    if (!Number.isFinite(applyTick) || applyTick < 0) {
        throw new Error(`invalid apply_tick in snapapply: ${snapapply}`);
    }
    if (!applyBlob || applyBlob.length < 5) {
        throw new Error(`empty snapapply blob: ${snapapply}`);
    }
    console.log(`[OK] agreeing snaps resolve to snapapply apply_tick=${applyTick}`);

    // Late-applier exclusion: a lying late client must not block quorum.
    const cConn = mockConn();
    const c = new Player(cConn, 3);
    server.addPlayer(c);
    const game3 = new MultiGame(
        a,
        93,
        "SnapLate",
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
        3,
        tm,
        false,
    );
    if (!game3.addPlayerWithPassword(b, "-") || !game3.addPlayerWithPassword(c, "-")) {
        throw new Error("failed to add players to 3-seat game");
    }
    a.game = game3;
    b.game = game3;
    c.game = game3;
    primeGameState(game3);

    aConn.sent.length = 0;
    bConn.sent.length = 0;
    cConn.sent.length = 0;

    triggerDivergence(game3, a, b);
    const nonce3 = parseSnapreqNonce([...aConn.sent, ...bConn.sent, ...cConn.sent]);

    const disagreeBlob = encodeBallSnapshot([
        { ...sampleSnapshot()[0]!, x: 999, y: 999 },
        sampleSnapshot()[1]!,
    ]);

    aConn.sent.length = 0;
    bConn.sent.length = 0;
    cConn.sent.length = 0;

    game3.handlePacket(a, ["game", "snap", String(nonce3), "0", "0", blob]);
    game3.handlePacket(b, ["game", "snap", String(nonce3), "1", "0", blob]);
    game3.handlePacket(c, ["game", "snap", String(nonce3), "2", "1", disagreeBlob]);

    const snapapply3 = [...aConn.sent, ...bConn.sent, ...cConn.sent].find((s) =>
        s.startsWith("game\tsnapapply\t"),
    );
    if (!snapapply3) {
        throw new Error("expected snapapply when two on-time clients agree and one is late");
    }
    console.log("[OK] late-applier excluded from recovery quorum");
}

async function assertDisconnectedExcludedFromQuorum(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());

    const server = new GolfServer(tm);
    const aConn = mockConn();
    const bConn = mockConn();
    const cConn = mockConn();
    const a = new Player(aConn, 10);
    const b = new Player(bConn, 11);
    const c = new Player(cConn, 12);
    server.addPlayer(a);
    server.addPlayer(b);
    server.addPlayer(c);

    const game = new MultiGame(
        a,
        94,
        "SnapDisconnect",
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
        3,
        tm,
        false,
    );
    if (!game.addPlayerWithPassword(b, "-") || !game.addPlayerWithPassword(c, "-")) {
        throw new Error("failed to add players");
    }
    a.game = game;
    b.game = game;
    c.game = game;
    c.disconnectedAt = Date.now();
    primeGameState(game);

    triggerDivergence(game, a, b);

    const nonce = parseSnapreqNonce([...aConn.sent, ...bConn.sent, ...cConn.sent]);
    const blob = encodeBallSnapshot(sampleSnapshot());

    aConn.sent.length = 0;
    bConn.sent.length = 0;
    cConn.sent.length = 0;

    game.handlePacket(a, ["game", "snap", String(nonce), "0", "0", blob]);
    game.handlePacket(b, ["game", "snap", String(nonce), "1", "0", blob]);

    const snapapply = [...aConn.sent, ...bConn.sent, ...cConn.sent].find((s) =>
        s.startsWith("game\tsnapapply\t"),
    );
    if (!snapapply) {
        throw new Error("expected snapapply with disconnected observer excluded from quorum");
    }
    console.log("[OK] disconnect-grace player excluded from recovery quorum");
}

async function main(): Promise<void> {
    await assertFullRecoveryCycle();
    await assertDisconnectedExcludedFromQuorum();
    console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
