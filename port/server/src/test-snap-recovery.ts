// Regression: ballend divergence must resolve through snapreq → snap → snapapply.
//
// Pre-fix coverage only asserted `snapreq` fired (test-ballend-sparse-id.ts).
// The server-side quorum routing (`handleSnapResponse`), majority resolver
// integration, and `snapapply` broadcast were untested — a regression in any
// of those steps would leave krokkaus rooms permanently diverged after desync.
//
// Also locks in negative controls: agreeing observers must not fire recovery,
// and clients cannot spoof another observer's id on ballend or snap packets.
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

function mockConn(): Connection {
    const sent: string[] = [];
    return {
        sendDataRaw: (body: string) => {
            sent.push(body);
        },
        sendData: (...fields: (string | number | boolean)[]) => {
            sent.push(fields.join("\t"));
        },
        sent,
    } as unknown as Connection & { sent: string[] };
}

function ballEntry(slot: number, x: number, y: number): BallSnapshotEntry {
    return {
        slot,
        x,
        y,
        vx: 0,
        vy: 0,
        bounciness: 1,
        magnetMul: 1,
        flags: SNAP_FLAG_STOPPED,
        liquidTimer: 0,
        iterationsThisStroke: 100,
        downhillStuckCounter: 0,
        magnetStuckCounter: 0,
        spinningStuckCounter: 0,
        strokeStartX: x,
        strokeStartY: y,
        shoreX: x,
        shoreY: y,
        seedHex: "0",
    };
}

async function setupSparseGame(): Promise<{
    game: MultiGame;
    a: Player;
    b: Player;
    aConn: Connection & { sent: string[] };
    bConn: Connection & { sent: string[] };
}> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        throw new Error(`no tracks loaded from ${tracksDir()}`);
    }

    const server = new GolfServer(tm);
    const aConn = mockConn();
    const bConn = mockConn();
    const a = new Player(aConn, 1);
    const b = new Player(bConn, 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        88,
        "SnapRecovery",
        "-",
        2,
        0,
        0,
        10,
        60,
        0,
        1,
        0,
        0,
        4,
        tm,
        false,
    );
    if (!game.addPlayerWithPassword(b, "-")) {
        throw new Error("failed to add player B");
    }

    game.isPublic = false;
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    (game as unknown as { playStatus: string }).playStatus = "fppf";
    (game as unknown as { playersNumber: number[] }).playersNumber = [0, 3];
    (game as unknown as { numberIndex: number }).numberIndex = 4;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();

    return { game, a, b, aConn, bConn };
}

function allSent(
    aConn: Connection & { sent: string[] },
    bConn: Connection & { sent: string[] },
): string[] {
    return [...aConn.sent, ...bConn.sent];
}

function parseSnapreqNonce(line: string): number {
    const parts = line.split("\t");
    if (parts[1] !== "snapreq") throw new Error(`not a snapreq line: ${line}`);
    const nonce = parseInt(parts[2] ?? "", 10);
    if (!Number.isFinite(nonce)) throw new Error(`bad snapreq nonce in: ${line}`);
    return nonce;
}

async function main(): Promise<void> {
    const { game, a, b, aConn, bConn } = await setupSparseGame();

    // Negative: agreeing observers must not start recovery.
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "ballend", "0", "0", "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "3", "0", "100.1", "200.0", "42"]);
    if (allSent(aConn, bConn).some((line) => line.includes("snapreq"))) {
        throw new Error("agreeing ballend observations must not fire snapreq");
    }
    console.log("[OK] agreeing ballend does not trigger recovery");

    // Negative: claimed observer id must match the sender's slot.
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "ballend", "99", "0", "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "3", "0", "150.0", "200.0", "42"]);
    if (allSent(aConn, bConn).some((line) => line.includes("snapreq"))) {
        throw new Error("spoofed ballend observer id must be ignored");
    }
    console.log("[OK] ballend rejects spoofed observer id");

    // Positive: divergent reports on a sparse subject id → full recovery cycle.
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "ballend", "0", "3", "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "3", "3", "150.0", "200.0", "42"]);

    const snapreqLine = allSent(aConn, bConn).find((line) => line.includes("\tsnapreq\t"));
    if (!snapreqLine) {
        throw new Error(
            `expected snapreq after divergent ballend; got: ${allSent(aConn, bConn).join(" | ")}`,
        );
    }
    const nonce = parseSnapreqNonce(snapreqLine);
    console.log(`[OK] divergent ballend broadcast snapreq nonce=${nonce}`);

    const blob = encodeBallSnapshot([ballEntry(3, 100, 200)]);
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "snap", String(nonce), "0", "0", blob]);
    if (allSent(aConn, bConn).some((line) => line.includes("snapapply"))) {
        throw new Error("snapapply must wait for all expected observers");
    }
    game.handlePacket(b, ["game", "snap", String(nonce), "3", "0", blob]);

    const snapapplyLine = allSent(aConn, bConn).find((line) => line.startsWith("game\tsnapapply\t"));
    if (!snapapplyLine) {
        throw new Error(
            `expected snapapply after quorum snap replies; got: ${allSent(aConn, bConn).join(" | ")}`,
        );
    }
    const applyParts = snapapplyLine.split("\t");
    const applyTick = parseInt(applyParts[2] ?? "", 10);
    const applyBlob = applyParts[3] ?? "";
    if (!Number.isFinite(applyTick) || applyTick <= 0) {
        throw new Error(`snapapply missing valid apply_tick: ${snapapplyLine}`);
    }
    if (!applyBlob.startsWith("3,")) {
        throw new Error(`snapapply blob missing sparse slot 3: ${applyBlob}`);
    }
    console.log(`[OK] quorum snap replies broadcast snapapply apply_tick=${applyTick}`);

    // Negative: snap replies cannot spoof another observer's slot id.
    (game as unknown as { markTrackStart: () => void }).markTrackStart();
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "ballend", "0", "3", "100.0", "200.0", "99"]);
    game.handlePacket(b, ["game", "ballend", "3", "3", "150.0", "200.0", "99"]);
    const snapreq2 = allSent(aConn, bConn).find((l) => l.includes("snapreq"));
    if (!snapreq2) {
        throw new Error("expected second snapreq for snap spoof test");
    }
    const nonce2 = parseSnapreqNonce(snapreq2);
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "snap", String(nonce2), "3", "0", blob]);
    game.handlePacket(b, ["game", "snap", String(nonce2), "3", "0", blob]);
    if (allSent(aConn, bConn).some((line) => line.includes("snapapply"))) {
        throw new Error("snapapply must not resolve when only one real observer replied (spoof blocked)");
    }
    console.log("[OK] snap rejects spoofed observer id");

    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
