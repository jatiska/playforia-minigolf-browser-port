// Regression: `ballend` observations must accept sparse slot ids and complete
// desync recovery through `snapapply`.
//
// Pre-fix: `handleBallEndObservation` rejected `subjectId >= players.length`.
// After mid-game leavers, survivors can occupy slots 0 and 3 in a 4-seat room
// while `players.length` is 2 — every `ballend` for slot 3 was dropped, so
// desync recovery never fired and krokkaus games could stay diverged.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-ballend-sparse-id.ts

import * as path from "node:path";
import { encodeBallSnapshot, SNAP_FLAG_STOPPED } from "@minigolf/shared";
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
        77,
        "BallendSparse",
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

    // Started 4-seat room: leavers vacated slots 1 and 2; survivors at 0 and 3.
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

    // Two observers disagree on where slot 3's ball stopped → recovery snapreq.
    game.handlePacket(a, ["game", "ballend", "0", "3", "100.0", "200.0", "42"]);
    game.handlePacket(b, ["game", "ballend", "3", "3", "150.0", "200.0", "42"]);

    const sawSnapreq = allSent().some((line) => line.includes("snapreq"));
    if (!sawSnapreq) {
        throw new Error(
            "expected snapreq after divergent ballend for sparse subjectId=3; " +
                `got broadcasts: ${allSent().join(" | ")}`,
        );
    }

    const snapreqLine = allSent().find((line) => line.includes("snapreq"));
    const nonce = parseInt(snapreqLine?.split("\t")[2] ?? "", 10);
    if (!Number.isFinite(nonce)) {
        throw new Error(`could not parse snapreq nonce from: ${snapreqLine}`);
    }

    const blob = encodeBallSnapshot([
        {
            slot: 3,
            x: 150,
            y: 200,
            vx: 0,
            vy: 0,
            bounciness: 1,
            magnetMul: 1,
            flags: SNAP_FLAG_STOPPED,
            liquidTimer: 0,
            iterationsThisStroke: 10,
            downhillStuckCounter: 0,
            magnetStuckCounter: 0,
            spinningStuckCounter: 0,
            strokeStartX: 150,
            strokeStartY: 200,
            shoreX: 150,
            shoreY: 200,
            seedHex: "0",
        },
    ]);

    (aConn as Connection & { sent: string[] }).sent.length = 0;
    (bConn as Connection & { sent: string[] }).sent.length = 0;

    game.handlePacket(a, ["game", "snap", String(nonce), "0", "0", blob]);
    game.handlePacket(b, ["game", "snap", String(nonce), "3", "0", blob]);

    const sawSnapapply = allSent().some((line) => line.includes("snapapply"));
    if (!sawSnapapply) {
        throw new Error(
            "expected snapapply after matching snap replies; " +
                `got broadcasts: ${allSent().join(" | ")}`,
        );
    }

    console.log("[OK] ballend accepts sparse slot ids and completes recovery via snapapply");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
