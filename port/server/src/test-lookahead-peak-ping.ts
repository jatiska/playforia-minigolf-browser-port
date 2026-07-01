// Regression: stroke lookahead must size from peakPingMs, not avgPingMs.
//
// Krokkaus determinism depends on apply_tick being far enough in the future
// for the slowest/jitteriest client. The server uses peakPingMs (max over
// recent RTT samples) so a 5ms-mean / 180ms-spike connection gets the spike's
// lookahead — otherwise impulses apply "in the past" on that client and balls
// diverge for the rest of the stroke.
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

function mockConn(peakPingMs: number, avgPingMs: number): Connection {
    return {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
        peakPingMs,
        avgPingMs,
    } as unknown as Connection;
}

function expectedLookahead(peakMs: number): number {
    const ticks = Math.ceil((peakMs + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);
    if (ticks < MIN_LOOKAHEAD_TICKS) return MIN_LOOKAHEAD_TICKS;
    if (ticks > MAX_LOOKAHEAD_TICKS) return MAX_LOOKAHEAD_TICKS;
    return ticks;
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        console.error("FAIL: no tracks loaded from", tracksDir());
        process.exit(1);
    }

    const server = new GolfServer(tm);

    // Low avg but high peak — must use peak (180ms), not avg (5ms).
    const aConn = mockConn(180, 5);
    const bConn = mockConn(10, 10);
    const a = new Player(aConn, 1);
    const b = new Player(bConn, 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        89,
        "PeakPing",
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

    const lookahead = (game as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const want = expectedLookahead(180);
    if (lookahead !== want) {
        throw new Error(`expected lookahead ${want} from peak 180ms; got ${lookahead}`);
    }
    console.log(`[OK] lookahead=${lookahead} uses max peakPingMs across room`);

    // If we only had the low-ping player, lookahead would be smaller.
    const soloGame = new MultiGame(
        a,
        90,
        "SoloPeak",
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
    const soloLookahead = (soloGame as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const soloWant = expectedLookahead(180);
    if (soloLookahead !== soloWant) {
        throw new Error(`solo game expected lookahead ${soloWant}; got ${soloLookahead}`);
    }

    // Zero peak still yields ceil(safety/6) ticks (>= MIN_LOOKAHEAD_TICKS).
    const lowConn = mockConn(0, 0);
    const lowPlayer = new Player(lowConn, 3);
    server.addPlayer(lowPlayer);
    const lowGame = new MultiGame(
        lowPlayer,
        91,
        "MinClamp",
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
    const lowLookahead = (lowGame as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const lowWant = expectedLookahead(0);
    if (lowLookahead !== lowWant || lowLookahead < MIN_LOOKAHEAD_TICKS) {
        throw new Error(`expected lookahead ${lowWant} (>= MIN ${MIN_LOOKAHEAD_TICKS}); got ${lowLookahead}`);
    }
    console.log(`[OK] zero peak ping yields lookahead=${lowLookahead} (>= MIN)`);

    // MAX clamp: absurd RTT must not exceed MAX_LOOKAHEAD_TICKS.
    const highConn = mockConn(50_000, 50_000);
    const highPlayer = new Player(highConn, 4);
    server.addPlayer(highPlayer);
    const highGame = new MultiGame(
        highPlayer,
        92,
        "MaxClamp",
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
    const highLookahead = (highGame as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    if (highLookahead !== MAX_LOOKAHEAD_TICKS) {
        throw new Error(`expected MAX clamp ${MAX_LOOKAHEAD_TICKS}; got ${highLookahead}`);
    }
    console.log(`[OK] high peak ping clamped to MAX_LOOKAHEAD_TICKS=${MAX_LOOKAHEAD_TICKS}`);

    console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
