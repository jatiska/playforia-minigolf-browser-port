// Regression: krokkaus hole-outs must not bump the victim's stroke counter.
//
// Pre-fix: MultiGame.endStroke overrode the base method without forwarding
// `src`, so every `game endstroke … k` packet was treated as a real stroke.
// A player knocked into a hole by another ball would gain a spurious stroke on
// the scoreboard.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-endstroke-krokkaus.ts

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
        88,
        "KrokEndstroke",
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

    game.isPublic = false;
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    (game as unknown as { playStatus: string }).playStatus = "ff";
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    game.playerStrokesThisTrack[0] = 4;
    game.playerStrokesThisTrack[1] = 6;

    // Victim (slot 1) reports a krokkaus hole-out: src=k must not bump strokes.
    game.handlePacket(b, ["game", "endstroke", "1", "ft", "k"]);
    if (game.playerStrokesThisTrack[1] !== 6) {
        throw new Error(
            `src=k must not bump strokes; playerStrokesThisTrack[1]=${game.playerStrokesThisTrack[1]}, want 6`,
        );
    }

    // Shooter (slot 0) ends a real stroke still in play: src=s must bump without
    // holing (which would trigger nextTrack and reset counters).
    game.handlePacket(a, ["game", "endstroke", "0", "ff", "s"]);
    if (game.playerStrokesThisTrack[0] !== 5) {
        throw new Error(
            `src=s must bump strokes; playerStrokesThisTrack[0]=${game.playerStrokesThisTrack[0]}, want 5`,
        );
    }

    console.log("[OK] MultiGame forwards endstroke src=k without bumping victim strokes");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
