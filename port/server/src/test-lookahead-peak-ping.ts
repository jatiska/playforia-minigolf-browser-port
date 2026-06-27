// Regression: stroke lookahead must use peakPingMs, not avgPingMs.
//
// A connection with low average RTT but occasional spikes needs lookahead
// sized to the spike — otherwise apply_tick lands in the past on the unlucky
// client and krokkaus peer positions diverge for the rest of the stroke.
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

function mockConn(ping: { avg: number; peak: number }): Connection {
    return {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
        avgPingMs: ping.avg,
        peakPingMs: ping.peak,
    } as unknown as Connection;
}

function expectedLookahead(peakMs: number): number {
    const raw = Math.ceil((peakMs + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);
    if (raw < MIN_LOOKAHEAD_TICKS) return MIN_LOOKAHEAD_TICKS;
    if (raw > MAX_LOOKAHEAD_TICKS) return MAX_LOOKAHEAD_TICKS;
    return raw;
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());

    const server = new GolfServer(tm);
    const a = new Player(mockConn({ avg: 15, peak: 90 }), 1);
    const b = new Player(mockConn({ avg: 15, peak: 15 }), 2);
    server.addPlayer(a);
    server.addPlayer(b);

    const game = new MultiGame(
        a,
        99,
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
    if (!game.addPlayerWithPassword(b, "-")) {
        throw new Error("failed to add player B");
    }

    const lookahead = (game as unknown as { getStrokeLookaheadTicks(): number }).getStrokeLookaheadTicks();
    const want = expectedLookahead(90);
    const avgOnly = expectedLookahead(15);

    if (lookahead !== want) {
        throw new Error(
            `lookahead must follow peak ping (90ms→${want}t), not avg (15ms→${avgOnly}t); got ${lookahead}t`,
        );
    }
    if (lookahead === avgOnly) {
        throw new Error(
            `lookahead ${lookahead}t matches avg-only case — peak ping ignored`,
        );
    }

    console.log(`[OK] lookahead=${lookahead}t uses peak ping (90ms), not avg (15ms)`);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
