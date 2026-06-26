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

    // Regression: sparse slot ids after mid-game leavers. Survivors can occupy
    // slots 0 and 3 while players.length is 2. The starttrack buff must stay
    // numPlayers-wide so the reconnecting client's playStatus gate and scoreboard
    // align with peers — shrinking to players.length leaves slot 3 off the end.
    const sparseSent: string[] = [];
    const sparseConn = {
        sendDataRaw: (body: string) => {
            sparseSent.push(body);
        },
        sendData: (...fields: (string | number | boolean)[]) => {
            sparseSent.push(fields.join("\t"));
        },
    } as unknown as Connection;

    const sparseCreatorConn = makeMockConn();
    const sparseSurvivorConn = sparseConn;
    const sparseCreator = new Player(sparseCreatorConn, 10);
    const sparseSurvivor = new Player(sparseSurvivorConn, 11);
    server.addPlayer(sparseCreator);
    server.addPlayer(sparseSurvivor);

    const sparseGame = new MultiGame(
        sparseCreator,
        100,
        "CatchupSparse",
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
    if (!sparseGame.addPlayerWithPassword(sparseSurvivor, "-")) {
        throw new Error("failed to add sparse survivor");
    }
    sparseGame.isPublic = false;
    (sparseGame as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    (sparseGame as unknown as { currentTrack: number }).currentTrack = 0;
    (sparseGame as unknown as { playStatus: string }).playStatus = "fppf";
    (sparseGame as unknown as { playersNumber: number[] }).playersNumber = [0, 3];
    (sparseGame as unknown as { numberIndex: number }).numberIndex = 4;

    sparseSent.length = 0;
    sparseGame.sendReconnectResync(sparseSurvivor);

    const sparseStart = sparseSent.find((b) => b.startsWith("game\tstarttrack\t"));
    if (!sparseStart) {
        throw new Error("sparse reconnect catchup missing starttrack");
    }
    const sparseBuff = sparseStart.split("\t")[2] ?? "";
    if (sparseBuff.length !== 4) {
        throw new Error(
            `sparse reconnect starttrack buff length=${sparseBuff.length}; want 4 (numPlayers)`,
        );
    }
    console.log("[OK] sparse-id reconnect catchup keeps full-width starttrack buff");

    process.exit(0);
}

function makeMockConn(): Connection {
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

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
