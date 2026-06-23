// Physics regressions for water respawn anchors, krokkaus spawn stacks, and
// inside-corner wall reflection.
//
// Usage: node --test --experimental-strip-types src/game/physics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Seed, MAP_PIXEL_WIDTH } from "@minigolf/shared";
import { newBall, step, type PhysicsContext } from "./physics.ts";
import type { ParsedMap } from "./map.ts";
import type { Atlases } from "./sprites.ts";

const SOLID_WALL = 16;
/** Matches physics.ts DIAG_OFFSET (6 * sqrt(2)/2, rounded). */
const DIAG_OFFSET = 4;

function emptyMap(collision?: Uint8Array): ParsedMap {
    return {
        tiles: [],
        collision: collision ?? new Uint8Array(MAP_PIXEL_WIDTH * 375),
        startPositions: [[50, 50]],
        resetPositions: [null, null, null, null],
        teleportStarts: [[], [], [], []],
        teleportExits: [[], [], [], []],
        magnetMap: null,
        dirtyTiles: [],
        atlases: {} as Atlases,
    };
}

function setWall(collision: Uint8Array, x: number, y: number): void {
    collision[y * MAP_PIXEL_WIDTH + x] = SOLID_WALL;
}

function mapWithWaterAt(px: number, py: number): ParsedMap {
    const collision = new Uint8Array(MAP_PIXEL_WIDTH * 375);
    collision[py * MAP_PIXEL_WIDTH + px] = 12;
    return emptyMap(collision);
}

/** L-shaped solid wall above/left of the ball - reproduces AdventureIV wall-clip. */
function mapWithTLCornerAboveBall(bx: number, by: number): ParsedMap {
    const collision = new Uint8Array(MAP_PIXEL_WIDTH * 375);
    for (let dx = -10; dx <= 10; dx++) {
        setWall(collision, bx + dx, by - 6);
    }
    for (let dy = -10; dy <= 4; dy++) {
        setWall(collision, bx - 6, by + dy);
    }
    for (let dx = -6; dx <= 6; dx++) {
        for (let dy = -6; dy <= 6; dy++) {
            setWall(collision, bx - DIAG_OFFSET + dx, by - DIAG_OFFSET + dy);
        }
    }
    return emptyMap(collision);
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

test("vertical approach to L-corner wall must bounce, not phase through", () => {
    const bx = 100;
    const by = 120;
    const map = mapWithTLCornerAboveBall(bx, by);
    const ball = newBall(bx, by);
    ball.vx = 0;
    ball.vy = -7;

    step(ball, baseCtx(map, 0));

    assert.ok(ball.vy > 0, "ball should reflect off top wall (vy flips positive)");
    assert.ok(ball.y >= by - 12, "ball should not phase through the wall cluster");
});

test("krokkaus skips collision for stationary overlapping spawn stack", () => {
    const map = emptyMap();
    const peer1 = newBall(100, 100);
    const peer2 = newBall(100, 100);
    const ball = newBall(100, 100);
    ball.vx = 10;
    ball.vy = 0;

    const ctx: PhysicsContext = {
        ...baseCtx(map, 0),
        peers: [ball, peer1, peer2],
        myIdx: 0,
    };

    step(ball, ctx);

    assert.equal(peer1.vx, 0, "stacked idle peer should not receive krokkaus impulse");
    assert.equal(peer2.vx, 0, "stacked idle peer should not receive krokkaus impulse");
});

test("krokkaus applies collision once idle peer is not in overlap group", () => {
    const map = emptyMap();
    const peer = newBall(106, 100);
    const ball = newBall(100, 100);
    ball.vx = 10;
    ball.vy = 0;

    const ctx: PhysicsContext = {
        ...baseCtx(map, 0),
        peers: [ball, peer],
        myIdx: 0,
    };

    step(ball, ctx);

    assert.ok(peer.vx > 0, "lone idle peer should receive krokkaus impulse");
    assert.ok(ball.vx < 10, "shooter should transfer momentum to lone idle peer");
});
