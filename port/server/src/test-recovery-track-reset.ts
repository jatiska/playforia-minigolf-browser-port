// Regression: markTrackStart must clear in-flight desync-recovery state.
//
// When the room advances to a new hole, the world clock re-anchors. Stale
// ballend observations and pending snap sessions from the prior hole must be
// wiped — otherwise a new stroke could resolve against meaningless ticks or a
// timed-out session could snapapply against the wrong track state.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-recovery-track-reset.ts

import * as path from "node:path";
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
        peakPingMs: 15,
    } as unknown as Connection & { sent: string[] };
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        console.error("FAIL: no tracks loaded from", tracksDir());
        process.exit(1);
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
        95,
        "RecoveryReset",
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

    (game as unknown as { playStatus: string }).playStatus = "ff";
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();

    // Divergent ballend → snapreq + pending recovery session (unanswered).
    game.handlePacket(a, ["game", "ballend", "0", "0", "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "1", "0", "150.0", "200.0", "42"]);

    const pendingBefore = (game as unknown as { pendingRecoveries: Map<number, unknown> }).pendingRecoveries;
    const obsBefore = (game as unknown as { ballEndObservations: Map<number, unknown[]> }).ballEndObservations;
    if (pendingBefore.size === 0) {
        throw new Error("expected pending recovery session before markTrackStart");
    }
    if (obsBefore.size === 0) {
        throw new Error("expected ballEndObservations before markTrackStart");
    }
    const nonceBefore = [...pendingBefore.keys()][0]!;

    (game as unknown as { markTrackStart(): void }).markTrackStart();

    const pendingAfter = (game as unknown as { pendingRecoveries: Map<number, unknown> }).pendingRecoveries;
    const obsAfter = (game as unknown as { ballEndObservations: Map<number, unknown[]> }).ballEndObservations;
    if (pendingAfter.size !== 0) {
        throw new Error(`pendingRecoveries not cleared; size=${pendingAfter.size}`);
    }
    if (obsAfter.size !== 0) {
        throw new Error(`ballEndObservations not cleared; size=${obsAfter.size}`);
    }
    console.log("[OK] markTrackStart clears pending recovery and ballend observations");

    // A single ballend after reset must not immediately re-fire recovery
    // (needs RECOVERY_MIN_OBSERVERS=2 fresh reports).
    aConn.sent.length = 0;
    bConn.sent.length = 0;
    game.handlePacket(a, ["game", "ballend", "0", "0", "100.0", "200.0", "99"]);
    const prematureSnapreq = [...aConn.sent, ...bConn.sent].some((s) => s.includes("snapreq"));
    if (prematureSnapreq) {
        throw new Error("single ballend after reset must not trigger snapreq");
    }

    // Fresh divergence on the new track gets a new nonce (counter advanced).
    game.handlePacket(b, ["game", "ballend", "1", "0", "150.0", "200.0", "99"]);
    const snapreqLine = [...aConn.sent, ...bConn.sent].find((s) => s.startsWith("game\tsnapreq\t"));
    if (!snapreqLine) {
        throw new Error("expected fresh snapreq after new-track divergence");
    }
    const nonceAfter = parseInt(snapreqLine.split("\t")[2] ?? "", 10);
    if (nonceAfter <= nonceBefore) {
        throw new Error(`expected new nonce after track reset; before=${nonceBefore} after=${nonceAfter}`);
    }
    console.log("[OK] new-track divergence starts fresh recovery session");

    console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
