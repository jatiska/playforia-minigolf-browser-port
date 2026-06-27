// Regression: mid-game reconnect catchup must not broadcast `game start`.
//
// `game start` is correct for late joiners (fresh panel) but wipes a
// reconnecting client's in-memory hole scores and resets currentTrackIdx to 0.
// Catchup should mirror `sendCurrentTrackTo`: resetvoteskip + starttrack +
// gametrack (when past hole 1) + endstroke replays.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-reconnect-catchup.ts

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

async function main(): Promise<void> {
    const tm = new TrackManager();
    await tm.load(tracksDir());
    if (tm.getRandomTracks(1, 0).length === 0) {
        console.error("FAIL: no tracks loaded from", tracksDir());
        process.exit(1);
    }

    const sent: string[] = [];
    const mockConn = {
        sendDataRaw: (body: string) => {
            sent.push(body);
        },
        sendData: (...fields: (string | number | boolean)[]) => {
            sent.push(fields.join("\t"));
        },
    } as unknown as Connection;

    const server = new GolfServer(tm);
    const creator = new Player(mockConn, 1);
    server.addPlayer(creator);

    const game = new MultiGame(
        creator,
        99,
        "CatchupRoom",
        "-",
        3,
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

    // Mid-round state without a full networked match.
    game.isPublic = false;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    (game as unknown as { currentTrack: number }).currentTrack = 1;
    (game as unknown as { playStatus: string }).playStatus = "ff";

    sent.length = 0;
    game.sendReconnectResync(creator);

    const hasStart = sent.some((b) => b === "game\tstart");
    const hasStartTrack = sent.some((b) => b.startsWith("game\tstarttrack\t"));
    const hasGametrack = sent.some((b) => b === "game\tgametrack\t2");

    if (hasStart) {
        throw new Error("catchup must not include `game start` (wipes client scoreboard)");
    }
    if (!hasStartTrack) {
        throw new Error("catchup missing starttrack");
    }
    if (!hasGametrack) {
        throw new Error("catchup on track 2 must include `game gametrack 2`");
    }

    console.log("[OK] reconnect catchup omits game start and includes gametrack on hole 2");

    // Hole 1 reconnect must also emit gametrack 1: starttrack alone bumps
    // the client's currentTrackIdx by one, so without gametrack scores land
    // in the wrong column.
    (game as unknown as { currentTrack: number }).currentTrack = 0;
    sent.length = 0;
    game.sendReconnectResync(creator);

    if (!sent.some((b) => b === "game\tgametrack\t1")) {
        throw new Error("catchup on track 1 must include `game gametrack 1`");
    }
    console.log("[OK] reconnect catchup includes gametrack on hole 1");

    // 4-seat room with sparse survivors: catchup starttrack buff must stay
    // numPlayers-wide, not shrink to players.length.
    const sparseGame = new MultiGame(
        creator,
        100,
        "SparseCatchup",
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
    sparseGame.isPublic = false;
    (sparseGame as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    (sparseGame as unknown as { currentTrack: number }).currentTrack = 0;
    (sparseGame as unknown as { playStatus: string }).playStatus = "fppf";
    (sparseGame as unknown as { playersNumber: number[] }).playersNumber = [0, 3];
    (sparseGame as unknown as { numberIndex: number }).numberIndex = 4;

    sent.length = 0;
    sparseGame.sendReconnectResync(creator);
    const startLine = sent.find((b) => b.startsWith("game\tstarttrack\t"));
    if (!startLine) {
        throw new Error("sparse catchup missing starttrack");
    }
    const buff = startLine.split("\t")[2] ?? "";
    if (buff.length !== 4) {
        throw new Error(`sparse catchup starttrack buff width should be 4 (numPlayers), got ${buff.length}: "${buff}"`);
    }
    console.log("[OK] reconnect catchup starttrack uses playStatusCapacity for sparse rooms");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
