// Regression: krokkaus `endstroke` with src='k' must not bump stroke count.
//
// When a player is knocked into the hole by another ball, the client sends
// `game endstroke <id> <playStatus> k`. The server marks them holed but must
// NOT increment their stroke counter — they didn't take a shot themselves.
//
// Pre-fix: MultiGame.endStroke overrode GolfGame without forwarding `src`,
// so every krokkaus hole-in counted as an extra stroke in multiplayer rooms.
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
        88,
        "KrokEnd",
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
    (game as unknown as { playersNumber: number[] }).playersNumber = [0, 1];
    (game as unknown as { numberIndex: number }).numberIndex = 2;
    (game as unknown as { trackStartedAtMs: number }).trackStartedAtMs = performance.now();
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [1, 2];

    const allSent = (): string[] => [
        ...(aConn as Connection & { sent: string[] }).sent,
        ...(bConn as Connection & { sent: string[] }).sent,
    ];

    // Control first: a normal stroke (src='s') must bump before anyone holes out.
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [1, 2];
    game.handlePacket(a, ["game", "endstroke", "0", "ff", "s"]);
    const strokesAfterNormal = (game as unknown as { playerStrokesThisTrack: number[] })
        .playerStrokesThisTrack;
    if (strokesAfterNormal[0] !== 2) {
        throw new Error(
            `normal endstroke must bump strokes; expected 2, got ${strokesAfterNormal[0]}`,
        );
    }

    // Player B (slot 1) knocked into hole by A's ball — src='k'.
    (aConn as Connection & { sent: string[] }).sent.length = 0;
    (bConn as Connection & { sent: string[] }).sent.length = 0;
    (game as unknown as { playStatus: string }).playStatus = "ff";
    (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack = [2, 2];
    game.handlePacket(b, ["game", "endstroke", "1", "ft", "k"]);

    const strokes = (game as unknown as { playerStrokesThisTrack: number[] }).playerStrokesThisTrack;
    if (strokes[1] !== 2) {
        throw new Error(
            `krokkaus endstroke must not bump strokes; expected 2, got ${strokes[1]}`,
        );
    }

    const endLine = allSent().find((line) => line.includes("endstroke") && line.includes("\t1\t"));
    if (!endLine) {
        throw new Error(`expected endstroke broadcast for slot 1; got: ${allSent().join(" | ")}`);
    }
    const parts = endLine.split("\t");
    const strokeField = parts[parts.indexOf("endstroke") + 2];
    const statusField = parts[parts.indexOf("endstroke") + 3];
    if (strokeField !== "2" || statusField !== "t") {
        throw new Error(
            `expected broadcast endstroke 1 2 t; got stroke=${strokeField} status=${statusField} in ${endLine}`,
        );
    }

    console.log("[OK] krokkaus endstroke preserves stroke count; normal endstroke bumps");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
