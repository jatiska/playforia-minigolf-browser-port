// Regression: nextTrack must not shrink playStatus when slot ids are sparse.
//
// After a voluntary leave the remaining players keep their original ids
// (numberIndex only grows). Pre-fix nextTrack rebuilt playStatus as
// "f".repeat(players.length), truncating the highest id off the end so
// beginstroke silently rejected that player on every subsequent hole.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-nexttrack-sparse.ts

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
        sendDataRaw: () => {},
        sendData: () => {},
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
    const conns = [mockConn(), mockConn(), mockConn(), mockConn()];
    const players = conns.map((c, i) => {
        const p = new Player(c, i + 1);
        server.addPlayer(p);
        return p;
    });

    const game = new MultiGame(
        players[0],
        42,
        "SparseNext",
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

    // Simulate a started 4-player room: ids 0..3, then player 0 leaves.
    game.isPublic = false;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    (game as unknown as { playStatus: string }).playStatus = "pfff";
    (game as unknown as { numberIndex: number }).numberIndex = 4;
    (game as unknown as { playersNumber: number[] }).playersNumber = [1, 2, 3];
    (game as unknown as { players: Player[] }).players = [players[1], players[2], players[3]];

    (game as unknown as { nextTrack: () => void }).nextTrack();

    const ps = (game as unknown as { playStatus: string }).playStatus;
    if (ps.length < 4) {
        throw new Error(
            `nextTrack shrunk playStatus to length ${ps.length}; want >= 4 so id=3 stays addressable`,
        );
    }
    if (ps.charAt(3) !== "f") {
        throw new Error(`slot id=3 should be 'f' on a fresh hole, got "${ps.charAt(3)}"`);
    }
    if (ps.charAt(0) !== "p") {
        throw new Error(`departed slot 0 should stay 'p', got "${ps.charAt(0)}"`);
    }
    // beginstroke gate is playStatus.charAt(playerId) === 'f'.
    if (ps.charAt(3) !== "f") {
        throw new Error(`beginstroke gate would reject id=3: charAt(3)="${ps.charAt(3)}"`);
    }

    console.log("[OK] nextTrack preserves sparse slot ids and departed 'p' markers");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
