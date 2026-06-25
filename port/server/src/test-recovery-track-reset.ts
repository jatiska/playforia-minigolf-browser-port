// Regression: markTrackStart must wipe in-flight desync-recovery state.
//
// When a new hole begins the world clock re-anchors via markTrackStart().
// Prior ballend observations and pending snapreq sessions reference ticks
// from the old track — letting them survive would either fire spurious
// recovery on unrelated strokes or resolve against stale world state.
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

function mockConn(): Connection {
    return {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
    } as unknown as Connection;
}

type RecoverySession = {
    nonce: number;
    triggerSubjectId: number;
    timer: ReturnType<typeof setTimeout>;
};

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        console.error("FAIL: no tracks loaded from", tracksDir());
        process.exit(1);
    }

    const server = new GolfServer(tm);
    const a = new Player(mockConn(), 1);
    const b = new Player(mockConn(), 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        89,
        "RecoveryReset",
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
        2,
        tm,
        false,
    );
    if (!game.addPlayerWithPassword(b, "-")) {
        throw new Error("failed to add player B");
    }

    const g = game as unknown as {
        ballEndObservations: Map<number, unknown[]>;
        pendingRecoveries: Map<number, RecoverySession>;
        markTrackStart(): void;
    };

    g.ballEndObservations.set(0, [{ observerId: 0, x: 1, y: 2, worldTick: 5, receivedAtMs: performance.now() }]);
    const fired: boolean[] = [false];
    const timer = setTimeout(() => {
        fired[0] = true;
    }, 50_000);
    g.pendingRecoveries.set(1, {
        nonce: 1,
        triggerSubjectId: 0,
        timer,
    });

    g.markTrackStart();

    if (g.ballEndObservations.size !== 0) {
        throw new Error(`ballEndObservations should be empty after markTrackStart, size=${g.ballEndObservations.size}`);
    }
    if (g.pendingRecoveries.size !== 0) {
        throw new Error(`pendingRecoveries should be empty after markTrackStart, size=${g.pendingRecoveries.size}`);
    }

    // Timer must have been cleared — if not, it would eventually fire against
    // a deleted session and risk a stray resolveRecoverySession call.
    await new Promise((r) => setTimeout(r, 10));
    if (fired[0]) {
        throw new Error("pending recovery timer was not cleared by markTrackStart");
    }

    console.log("[OK] markTrackStart clears ballend observations and pending recovery sessions");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
