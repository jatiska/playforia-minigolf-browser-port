// Regression: after leavers, nextTrack and voteSkip must use slot ids
// (playersNumber), not array indices or players.length. A 4-player room with
// survivors at slots 0 and 3 must keep playStatus length 4 so slot 3 can shoot.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-sparse-slots.ts

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
        42,
        "SparseSlots",
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

    // Simulate a started 4-player room where slots 1 and 2 left; survivors
    // occupy slots 0 and 3 (playersNumber = [0, 3]).
    game.isPublic = false;
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    (game as unknown as { playStatus: string }).playStatus = "fppf";
    (game as unknown as { playersNumber: number[] }).playersNumber = [0, 3];
    (game as unknown as { numberIndex: number }).numberIndex = 4;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();

    const allSent = (): string[] => [
        ...(aConn as Connection & { sent: string[] }).sent,
        ...(bConn as Connection & { sent: string[] }).sent,
    ];

    // voteSkip: both survivors vote; slot 3 must be capped and marked 'p'.
    a.hasSkipped = true;
    b.hasSkipped = true;
    (aConn as Connection & { sent: string[] }).sent.length = 0;
    (bConn as Connection & { sent: string[] }).sent.length = 0;
    game.handlePacket(a, ["game", "voteskip"]);
    const endstrokes = allSent().filter((s) => s.startsWith("game\tendstroke\t"));
    const slot3End = endstrokes.find((s) => s.startsWith("game\tendstroke\t3\t"));
    if (!slot3End) {
        throw new Error(`voteSkip must emit endstroke for slot 3, got: ${JSON.stringify(endstrokes)}`);
    }

    // nextTrack: playStatus must stay numPlayers-wide (4), not shrink to 2.
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    (game as unknown as { playStatus: string }).playStatus = "tptt";
    (game as unknown as { tracks: unknown[] }).tracks = tm.getRandomTracks(2, 0);
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [3, 0, 0, 5];
    (game as unknown as { playerStrokesTotal: number[] }).playerStrokesTotal = [0, 0, 0, 0];

    (bConn as Connection & { sent: string[] }).sent.length = 0;
    (game as unknown as { nextTrack: () => void }).nextTrack.call(game);

    const ps = (game as unknown as { playStatus: string }).playStatus;
    if (ps.length !== 4) {
        throw new Error(`nextTrack playStatus length should be numPlayers (4), got ${ps.length}: "${ps}"`);
    }
    if (ps.charAt(3) !== "f") {
        throw new Error(`slot 3 should reset to 'f' after nextTrack, got '${ps.charAt(3)}'`);
    }

    console.log("[OK] voteSkip and nextTrack preserve sparse slot ids");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
