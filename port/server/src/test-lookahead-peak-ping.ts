// Regression: krokkaus lookahead must size off peakPingMs, not avgPingMs.
//
// Pre-fix: getStrokeLookaheadTicks used the EWMA average RTT. A connection
// with a low steady ping but occasional spikes (common on Wi‑Fi / mobile)
// would undershoot lookahead — the beginstroke broadcast lands on the "past"
// side of apply_tick on the unlucky client and peer ball positions diverge.
//
// Post-fix: max(player.connection.peakPingMs) over the room. This test sets
// one player's avgPingMs=10 but peakPingMs=90 and asserts lookahead reflects
// the spike, not the mean.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-lookahead-peak-ping.ts

import * as path from "node:path";
import {
    MultiGame,
    PHYSICS_STEP_MS,
    LOOKAHEAD_SAFETY_MS,
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
        get peakPingMs() {
            return peakPingMs;
        },
    } as unknown as Connection;
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        console.error("FAIL: no tracks loaded from", tracksDir());
        process.exit(1);
    }

    const server = new GolfServer(tm);
    const a = new Player(mockConn(10, 90), 1);
    const b = new Player(mockConn(10, 10), 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        88,
        "PeakPing",
        "-",
        2,
        0,
        0,
        10,
        60,
        0,
        1, // collision on
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
    const expectedFromPeak = Math.ceil((90 + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);
    const expectedFromAvg = Math.ceil((10 + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);

    if (lookahead !== expectedFromPeak) {
        throw new Error(
            `lookahead must use peakPingMs (90ms) → ${expectedFromPeak} ticks; ` +
                `got ${lookahead} (avg-only would be ${expectedFromAvg})`,
        );
    }
    if (lookahead === expectedFromAvg) {
        throw new Error("lookahead matched avgPingMs — peakPingMs regression");
    }

    console.log(`[OK] lookahead=${lookahead} ticks sized from peak ping spike (${expectedFromPeak}, not avg ${expectedFromAvg})`);
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
