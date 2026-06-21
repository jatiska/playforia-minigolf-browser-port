// Regression: water-event=0 respawns at strokeStart, not shore.
//
// Krokkaus can push an idle peer into water. game.ts snapshots each idle
// peer's resting position into strokeStartX/Y at stroke begin so water-event=0
// returns them to where they were before the hit, not their last own shot.
//
// Usage: node --test --experimental-strip-types src/game/physics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Seed, MAP_PIXEL_WIDTH } from "@minigolf/shared";
import { newBall, step, type PhysicsContext } from "./physics.ts";
import type { ParsedMap } from "./map.ts";
import type { Atlases } from "./sprites.ts";

function mapWithWaterAt(px: number, py: number): ParsedMap {
    const collision = new Uint8Array(MAP_PIXEL_WIDTH * 375);
    collision[py * MAP_PIXEL_WIDTH + px] = 12;
    return {
        tiles: [],
        collision,
        startPositions: [[50, 50]],
        resetPositions: [null, null, null, null],
        teleportStarts: [[], [], [], []],
        teleportExits: [[], [], [], []],
        magnetMap: null,
        dirtyTiles: [],
        atlases: {} as Atlases,
    };
}

function baseCtx(map: ParsedMap, waterEvent: number): PhysicsContext {
    return {
        map,
        seed: new Seed(1n),
        norandom: true,
        waterEvent,
        startX: 50,
        startY: 50,
        otherPlayers: [],
        collisionMode: 1,
        peers: [],
        myIdx: 0,
    };
}

function runUntilStopped(ball: ReturnType<typeof newBall>, ctx: PhysicsContext, maxSteps = 80): void {
    for (let i = 0; i < maxSteps && !ball.stopped; i++) {
        step(ball, ctx);
    }
}

test("waterEvent=0 respawns at strokeStart (krokkaus victim anchor)", () => {
    const px = 200;
    const py = 150;
    const map = mapWithWaterAt(px, py);
    const ball = newBall(px, py);
    // Resting position snapshotted when another player began their stroke.
    ball.strokeStartX = 310;
    ball.strokeStartY = 220;
    // Shore drifted during the push before landing in water.
    ball.shoreX = 280;
    ball.shoreY = 200;

    runUntilStopped(ball, baseCtx(map, 0));

    assert.ok(ball.stopped, "ball should stop after water respawn");
    assert.equal(ball.x, 310);
    assert.equal(ball.y, 220);
});

test("waterEvent=1 respawns at last shore, not strokeStart", () => {
    const px = 200;
    const py = 150;
    const map = mapWithWaterAt(px, py);
    const ball = newBall(px, py);
    ball.strokeStartX = 310;
    ball.strokeStartY = 220;
    ball.shoreX = 280;
    ball.shoreY = 200;

    runUntilStopped(ball, baseCtx(map, 1));

    assert.ok(ball.stopped, "ball should stop after water respawn");
    assert.equal(ball.x, 280);
    assert.equal(ball.y, 200);
});
