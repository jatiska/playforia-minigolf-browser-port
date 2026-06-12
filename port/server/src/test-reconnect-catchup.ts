// Regression: mid-game reconnect catchup must not broadcast `game start`.
//
// `game start` is correct for late joiners (fresh panel) but wipes a
// reconnecting client's in-memory hole scores and resets currentTrackIdx to 0.
// Catchup should mirror `sendCurrentTrackTo`: resetvoteskip + starttrack +
// gametrack (always — starttrack increments the client counter) + endstroke
// replays.
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

    game.isPublic = false;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();

    function runCatchup(currentTrack: number, playStatus: string): string[] {
        (game as unknown as { currentTrack: number }).currentTrack = currentTrack;
        (game as unknown as { playStatus: string }).playStatus = playStatus;
        sent.length = 0;
        game.sendReconnectResync(creator);
        return [...sent];
    }

    const hole1 = runCatchup(0, "ff");
    const hole2 = runCatchup(1, "ff");

    for (const [label, packets, wantGametrack] of [
        ["hole 1", hole1, "game\tgametrack\t1"],
        ["hole 2", hole2, "game\tgametrack\t2"],
    ] as const) {
        if (packets.some((b) => b === "game\tstart")) {
            throw new Error(`${label}: catchup must not include \`game start\` (wipes client scoreboard)`);
        }
        if (!packets.some((b) => b.startsWith("game\tstarttrack\t"))) {
            throw new Error(`${label}: catchup missing starttrack`);
        }
        if (!packets.some((b) => b === wantGametrack)) {
            throw new Error(`${label}: catchup must include \`${wantGametrack}\``);
        }
    }

    console.log("[OK] reconnect catchup omits game start and includes gametrack on every hole");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
