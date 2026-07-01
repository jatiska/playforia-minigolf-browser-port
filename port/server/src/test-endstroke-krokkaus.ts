// Regression: krokkaus hole-outs must not bump the victim's stroke counter.
//
// When a player is knocked into the hole by another player's stroke, the client
// sends `game endstroke <id> <playStatus> k`. The server marks them holed but
// must NOT increment their stroke count — they never took a shot themselves.
// Treating src='k' like src='s' inflates scores and can trigger false maxStrokes
// forfeits on the next hole.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-endstroke-krokkaus.ts

import * as path from "node:path";
import {
    LOOKAHEAD_SAFETY_MS,
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
        peakPingMs: 10,
    } as unknown as Connection & { sent: string[] };
}

function endstrokeLines(sent: string[]): string[] {
    return sent.filter((line) => line.startsWith("game\tendstroke\t"));
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
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [0, 0];
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();

    aConn.sent.length = 0;
    bConn.sent.length = 0;

    // Player 0 takes a real stroke and misses (status stays 'f').
    game.handlePacket(a, ["game", "endstroke", "0", "ff", "s"]);
    const afterRealStroke = (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack;
    if (afterRealStroke[0] !== 1) {
        throw new Error(`expected player 0 stroke count 1 after src=s; got ${afterRealStroke[0]}`);
    }
    const realEndstroke = endstrokeLines([...aConn.sent, ...bConn.sent]).find((l) => l.startsWith("game\tendstroke\t0\t"));
    if (!realEndstroke?.endsWith("\tf")) {
        throw new Error(`expected endstroke broadcast with status f; got ${realEndstroke}`);
    }
    console.log("[OK] src=s bumps stroke counter");

    aConn.sent.length = 0;
    bConn.sent.length = 0;

    // Player 1 is krokkaus-pushed into the hole without ever shooting.
    game.handlePacket(b, ["game", "endstroke", "1", "ft", "k"]);
    const afterKrok = (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack;
    if (afterKrok[1] !== 0) {
        throw new Error(`expected player 1 stroke count 0 after src=k; got ${afterKrok[1]}`);
    }
    const krokEndstroke = endstrokeLines([...aConn.sent, ...bConn.sent]).find((l) => l.startsWith("game\tendstroke\t1\t"));
    if (!krokEndstroke?.includes("\t0\tt")) {
        throw new Error(`expected endstroke broadcast 1 0 t; got ${krokEndstroke}`);
    }
    const playStatus = (game as unknown as { playStatus: string }).playStatus;
    if (playStatus.charAt(1) !== "t") {
        throw new Error(`expected playStatus slot 1 = t; got ${playStatus}`);
    }
    console.log("[OK] src=k marks holed without bumping strokes");

    // Contrast: same hole-in with src=s must bump.
    (game as unknown as { playStatus: string }).playStatus = "ff";
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [0, 0];
    aConn.sent.length = 0;
    bConn.sent.length = 0;

    game.handlePacket(b, ["game", "endstroke", "1", "ft", "s"]);
    const afterSelfHole = (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack;
    if (afterSelfHole[1] !== 1) {
        throw new Error(`expected player 1 stroke count 1 after self hole-in src=s; got ${afterSelfHole[1]}`);
    }
    console.log("[OK] src=s hole-in still bumps stroke counter");

    // Sanity: lookahead constants are exported for the peak-ping test.
    const expectedMin = MIN_LOOKAHEAD_TICKS;
    const ticks = Math.ceil((10 + LOOKAHEAD_SAFETY_MS) / PHYSICS_STEP_MS);
    if (expectedMin < 1 || ticks < expectedMin) {
        throw new Error("lookahead constants inconsistent");
    }

    console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
