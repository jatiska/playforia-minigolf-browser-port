// Regression: nextTrack stroke totals must index by slot id, not array index.
//
// Pre-fix: after player A (id=0) left a 2-player room, survivor B (id=1)
// sat at players[0]. nextTrack did `playerStrokesTotal[i] +=
// playerStrokesThisTrack[i]` with i=0, so B's hole strokes were never
// accumulated into playerStrokesTotal[1] — final scores under-counted.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-nexttrack-sparse-id.ts

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

function mockConnection(): Connection {
    return {
        sendDataRaw: () => { /* */ },
        sendData: () => { /* */ },
    } as unknown as Connection;
}

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(2, 0).length < 2) {
        console.error("FAIL: need at least 2 tracks in", tracksDir());
        process.exit(1);
    }

    const server = new GolfServer(tm);
    const creator = new Player(mockConnection(), 1);
    server.addPlayer(creator);

    const game = new MultiGame(
        creator,
        98,
        "SparseNextTrack",
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

    // Simulate: player B (slot id=1) is the sole remaining occupant at
    // players[0] after player A (slot id=0) left mid-match.
    const survivor = new Player(mockConnection(), 2);
    survivor.nick = "B";
    game.players.length = 0;
    game.playersNumber.length = 0;
    game.players.push(survivor);
    game.playersNumber.push(1);
    game.numberIndex = 2;
    game.isPublic = false;
    game.currentTrack = 0;
    game.playStatus = "t";
    game.playerStrokesThisTrack[1] = 7;
    game.playerStrokesTotal[0] = 0;
    game.playerStrokesTotal[1] = 0;

    (game as unknown as { nextTrack(): void }).nextTrack();

    if (game.playerStrokesTotal[1] !== 7) {
        throw new Error(
            `playerStrokesTotal[1]=${game.playerStrokesTotal[1]} after nextTrack; want 7 (sparse slot id)`,
        );
    }
    if (game.playerStrokesTotal[0] !== 0) {
        throw new Error(
            `playerStrokesTotal[0]=${game.playerStrokesTotal[0]} after nextTrack; want 0 (vacant slot)`,
        );
    }
    if (game.currentTrack !== 1) {
        throw new Error(`currentTrack=${game.currentTrack} after nextTrack; want 1`);
    }
    if (game.playerStrokesThisTrack[1] !== 0) {
        throw new Error(
            `playerStrokesThisTrack[1]=${game.playerStrokesThisTrack[1]} after nextTrack; want 0 (reset)`,
        );
    }

    console.log("[OK] nextTrack accumulates sparse-id strokes into playerStrokesTotal[id]");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
