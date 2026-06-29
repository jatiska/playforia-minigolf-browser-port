// Regression: krokkaus apply_tick lookahead must size from peakPingMs, not avgPingMs.
//
// A connection with a low EWMA but a recent spike still needs enough lookahead
// so the spike client does not apply peer impulses "in the past". Using avgPingMs
// would undershoot and reintroduce cross-client desync on jittery links.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-lookahead-peak-ping.ts

import * as path from "node:path";
import {
    LOOKAHEAD_SAFETY_MS,
    MAX_LOOKAHEAD_TICKS,
    MIN_LOOKAHEAD_TICKS,
    MultiGame,
    PHYSICS_STEP_MS,
} from "./game.ts";
import { TrackManager } from "./tracks.ts";
import { Player } from "./player.ts";
import type { Connection } from "./connection.ts";
import { GolfServer } from "./server.ts";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

function mockConn(avgPingMs: number, peakPingMs: number): Connection {
    return {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
        avgPingMs,
        peakPingMs,
    } as unknown as Connection;
}

function expectedLookaheadTicks(peakMs: number): number {
    const raw = Math.ceil((peakMs + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);
    if (raw < MIN_LOOKAHEAD_TICKS) return MIN_LOOKAHEAD_TICKS;
    if (raw > MAX_LOOKAHEAD_TICKS) return MAX_LOOKAHEAD_TICKS;
    return raw;
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());

    const server = new GolfServer(tm);
    const lowConn = mockConn(5, 5);
    const spikeConn = mockConn(5, 40);
    const low = new Player(lowConn, 1);
    const spike = new Player(spikeConn, 2);
    server.addPlayer(low);
    server.addPlayer(spike);

    const game = new MultiGame(
        low,
        89,
        "PeakPing",
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
    if (!game.addPlayerWithPassword(spike, "-")) {
        throw new Error("failed to add spike player");
    }

    const lookahead = (game as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const wantPeak = expectedLookaheadTicks(40);
    const wantAvg = expectedLookaheadTicks(5);

    if (wantPeak === wantAvg) {
        throw new Error("test setup error: peak and avg cases must differ");
    }
    if (lookahead !== wantPeak) {
        throw new Error(
            `lookahead=${lookahead} want ${wantPeak} (peak 40ms); avg-only would be ${wantAvg}`,
        );
    }

    // collision=0 must still skip lookahead entirely.
    const noCollision = new MultiGame(
        low,
        90,
        "NoCollision",
        "-",
        2,
        0,
        0,
        10,
        60,
        0,
        0,
        0,
        0,
        2,
        tm,
        false,
    );
    const zero = (noCollision as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    if (zero !== 0) {
        throw new Error(`collision=0 must skip lookahead; got ${zero}`);
    }

    console.log("[OK] getStrokeLookaheadTicks sizes from peakPingMs, not avgPingMs");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
