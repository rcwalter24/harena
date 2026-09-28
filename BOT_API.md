# Harena Bot API

<!-- GENERATED FILE: edit docs/BOT_API.template.md or src/engine/config.ts, then run `npm run docs`. -->

This document is everything you need to write a bot for **Harena**, a top-down 2D
arena shooter where every player is a program. Read it fully. The exact numbers are
in the tables, and your bot can also read them at runtime from `info.rules`.

---

## 1. What you write

A bot is **one JavaScript file** (an ES module) that exports two functions:

```js
export function init(info) { /* called once before the match */ }
export function decide(state) { /* called every tick; return an action */ return {}; }
export const meta = { name: 'My Bot', author: 'me' }; // optional
```

- `init(info)` runs once. `info` describes the map, the players, your id and every
  rule constant (see [InitInfo](#6-types)).
- `decide(state)` runs **30 times per second**. It receives the full game state and
  returns what to do this tick (see [Action](#6-types)).
- Module-level variables persist between calls, so keep memory there.
- The file must be self-contained: **no `import`/`require`**, no network, no timers,
  no async. `decide` must be synchronous. See [§8](#8-sandbox-limits-and-failures).

Minimal working bot (walks toward the nearest enemy and swings the knife):

```js
export function init(info) {}
export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;
  const enemies = state.players.filter((p) => p.id !== me.id && p.alive);
  if (enemies.length === 0) return null;
  const t = enemies.reduce((a, b) => (Math.hypot(a.x - me.x, a.y - me.y) < Math.hypot(b.x - me.x, b.y - me.y) ? a : b));
  const angle = Math.atan2(t.y - me.y, t.x - me.x);
  return { move: { x: Math.cos(angle), y: Math.sin(angle) }, aim: angle, attack: true };
}
```

---

## 2. The match

- Matches have 1–8 players. It is **free-for-all**: everyone else is an enemy.
  The same bot file may appear several times; each copy runs separately and cannot
  talk to the others.
- Everyone starts with **3 lives**, 100 hp, 0 shield and only a **knife**.
- When hp reaches 0 you lose a life. If you have lives left, you respawn after
  2 s. With no lives left you are **eliminated**.
- **The last player not eliminated wins.** If the time limit (default 180 s,
  `info.timeLimit`) runs out first, survivors are ranked by lives left, then by hp + shield.
  Eliminated players rank below all survivors, and a later elimination ranks higher.
  Exact ties share a rank.
- **The safe zone shrinks.** From 45 s the playable area closes in on the map centre, and
  standing outside it hurts ([§5.13](#513-safe-zone)). Hiding or waiting out the clock does not work.
- You see the whole map and everything on it. The only exception is enemies hiding in
  **bushes** ([§5.12](#512-bushes)).

---

## 3. Coordinates, angles, units

- Distances are world units (u). The map spans `x ∈ [0, width]`, `y ∈ [0, height]`,
  with the origin at the **top-left** corner. **+x is right, +y is down.**
- Angles are radians. `0` points right (+x), and angles **increase clockwise on screen**:
  `π/2` points down (+y). This is exactly `Math.atan2(dy, dx)` for a vector `(dx, dy)`.
  Angles in the state are normalized to (−π, π]. You may return any finite angle.
- The unit vector for angle `a` is `(Math.cos(a), Math.sin(a))`.
- Speeds are u/s and times are seconds. One tick is 1/30 s ≈ 33.333 ms.
- Walls are axis-aligned rectangles `{x, y, w, h}`, where `(x, y)` is the top-left corner.
  The map border is solid too.

---

## 4. The tick

Each tick, every bot receives the state **as it was after the previous tick**, and all
returned actions are applied **simultaneously**. The engine then resolves one tick in this
fixed order:

1. **Weapon switches**.
2. **Turning**: facing rotates toward your `aim`.
3. **Movement**, then walls and player–player collisions.
4. **Attacks**: knife swings hit instantly, new bullets/grenades start at your centre, and a laser starts
   charging.
5. **Projectiles** move along their path (bullets, then grenades), hitting walls or players. Then
   **lasers** whose charge ran out fire.
6. **Mines** whose fuse ran out explode, then **explosions** deal damage.
7. **Zone damage** (on whole seconds) to players outside the safe zone.
8. **Deaths**: lives are lost, gear is dropped, kills are credited.
9. **Pickups**.
10. **Respawns**, and gun pads refill.
11. **Cooldowns** count down, and time spent in bushes is updated (see [§5.12](#512-bushes)).

Consequences:
- Your action always reacts to state that is one tick old.
- Cooldowns in the state are **seconds until ready**, and `0` means you can act *this* tick.
  Durations are whole ticks: a cooldown of `c` seconds lasts `round(c × 30)` ticks.
- Damage from different sources in the same tick all lands. A player at 0 hp takes
  no more damage that tick, so the kill goes to whoever brought them to 0 first.

---

## 5. Rules

### 5.1 Movement and facing
- `move` is the velocity you **want**, as a direction vector. Its length is clamped to 1 and
  multiplies your weapon's top speed: knife 210 u/s, gun 190 u/s, launcher 180 u/s.
- **Movement has inertia.** Each tick your velocity moves toward the requested one by at most
  `topSpeed / 0.3` u/s per second: about 0.3 s from standing to full speed or back, and about
  twice that to reverse. The starting point is your actual velocity last tick (`self.vx/vy`),
  so bumping into a wall or a player slows you down. Returning no `move` brakes to a stop.
  Plan dodges early: you cannot change direction instantly.
- Players are circles of radius **16**. Walls push you out along their surface, so you
  slide along them. Players can't overlap: overlapping players are pushed apart equally.
- `state.self.vx/vy` is your *actual* velocity last tick. It is near 0 when you are
  pushing into a wall.
- Your **facing** turns toward `aim` by at most **540°/s** (18° per tick),
  taking the shorter way round. If you omit `aim`, facing stays where it is. **Attacks
  always go in your current facing, not in your `aim`**, so turn first, then attack.

### 5.2 Health, shield, invulnerability
- Max hp is 100 and max shield is 100. **Shield absorbs damage first**, and the
  remainder hits hp.
- After (re)spawning you are invulnerable for 1.5 s (`invulnerable` > 0). The
  invulnerability **ends as soon as you attack or plant a mine**. Projectiles still stop on invulnerable
  players but do no damage.

### 5.3 Knife (always owned)
- Damage **35**, cooldown **0.5 s**.
- A swing hits **every** enemy at once whose centre is within **68 u** of your centre
  (= 2 × radius + reach 36), and within **±50°** of your facing (the angle is measured to
  the enemy's centre), with no wall on the straight line between the two centres.

### 5.4 Gun
- You start without one. Pick up a `gun` item: map gun pads hold one at the start and
  refill 20 s after being emptied.
- Each shot uses 1 ammo and fires a bullet from your centre along your facing. Cooldown is
  **0.35 s**, damage **20**.
- Bullets fly straight at **480 u/s** (16 u per tick, about 2.3× player speed,
  so they can be dodged). They have radius 4 and range 900 u.
- A bullet stops at the first thing on its path: a wall (the bullet radius counts), or a player
  other than its shooter. A player is hit if the path comes within 20 u
  (player radius + bullet radius) of their centre. Bullets never hit their shooter. Bullets
  keep flying after their shooter dies.
- A gun item gives the gun (if you lack it) plus its ammo, up to 40. Pad and spawned
  guns carry 15, and dropped guns carry what their owner had.

### 5.5 Grenade launcher
- Picked up as a `launcher` item, which gives 3 grenades (max 6).
- It fires a grenade from your centre along your facing: speed 480 u/s,
  radius 6, cooldown 1.2 s.
- The grenade explodes when it touches a wall or any player other than its shooter, or after
  flying 700 u.
- Explosion radius is 80 u. Damage is 200 at the centre and falls linearly to
  20 at the edge. Distance is measured from the blast centre to the nearest point of the target
  (centre distance − 16).

### 5.6 Laser
- Picked up as a `laser` item, which gives 3 shots (max 6).
- **Attacking starts a charge.** The beam's direction is locked to your facing at that moment, and
  your facing stays locked until it fires. You can keep moving (top speed 190 u/s). After
  **0.75 s** the beam fires from wherever your centre is then. Starting a charge ends
  invulnerability, and while charging you are revealed like after an attack (see §5.12).
- **Everyone sees it coming.** `state.lasers` lists every charging laser with `charge` (seconds until it
  fires) and `path`: where the beam would go if it fired now, from the shooter's current centre. Your own
  and everyone's countdown is also `players[i].laserCharge`.
- The beam is **instant**. It goes straight, **reflects off walls and the map edge 1 time(s)** (angle
  in = angle out), and ends after 2000 u in total. It stops at the **first player it touches** (a
  player whose centre is within player radius + 3 u of the beam) and deals **60** damage.
  Before its bounce the beam passes through you, but **the reflected part can hit you** (a suicide if it kills you).
- A shot is used when the beam fires; then the laser has a 1.5 s cooldown (`cooldowns.laser`). Switching
  weapons or dying cancels a charge and keeps the shot.
- In `state.events`, laser damage shows up as `weapon: 'laser'`, and every shot as a `laser` event with its
  path and the player it hit.
- To dodge, get off the line early: with inertia you need a few ticks to change direction.

### 5.7 Mines
- Picked up as a `mines` item, which gives +2 (carry at most 3).
- `plantMine: true` plants one at your position, whatever weapon you hold, even while switching.
  Cooldown is 0.5 s.
- A mine explodes **2.5 s after being planted**, no matter who is nearby. Everyone can see mines
  and their remaining `fuse`. Radius is 100 u, damage 200 at the centre falling to 25 at the edge.
- An explosion **immediately detonates every other mine in its radius** (chain reaction).
- Mines don't block movement. They outlive their owner, and kills still go to the owner.

### 5.8 Explosions
- Walls block explosions: a player takes no damage if a wall is on the straight line
  from the blast centre to their centre.
- **Your own explosions hurt you** (×1 damage). Dying to your own explosive is a suicide,
  so nobody gets the kill.
- Damage is rounded to whole points. Several explosions in the same tick all apply.
- In `state.events`, explosion damage shows up as `weapon: 'explosion'`. `state.explosions` lists
  every blast from the previous tick.

### 5.9 Weapon switching
- Return `weapon: 'knife' | 'gun' | 'launcher' | 'laser'` to switch; you must own the weapon. The new weapon's
  speed applies at once, but you **cannot attack for 0.3 s** (`cooldowns.switch`).
- Requesting the weapon you already hold does nothing, so it is safe to send every tick.

### 5.10 Death, respawn, kills
- At 0 hp you lose a life. Your gun (if it has ammo), your launcher (if it has grenades) and your
  laser (if it has shots) drop where you died as items that keep their ammo. Carried mines drop as a `mines` item.
- You respawn after 2 s with full hp, 0 shield and only the knife. The spawn point is
  random among spawn points at least 300 u from every living enemy, or the farthest one if
  none qualifies. Once the safe zone shrinks, only spawn points inside it count; if none is left,
  you respawn at a free spot inside the zone, as far from enemies as possible.
- A kill is credited to the last *other* player who damaged you in that life.

### 5.11 Items
Items are circles of radius 12. You pick one up when your centre is within
**28 u** of it (player radius + item radius). If several players touch it, the closest one gets it.
**Items you can't use stay on the ground**: full hp, full shield, max ammo, and so on.

| Item | Effect | Picked up only if |
|---|---|---|
| `health` | +40 hp | hp < 100 |
| `shield` | +50 shield | shield < 100 |
| `life` | +1 life | lives < 5 |
| `ammo` | +10 gun ammo | you have a gun and ammo < 40 |
| `gun` | gun + its ammo | no gun yet, or gun ammo < 40 |
| `launcher` | launcher + its grenades | no launcher yet, or grenades < 6 |
| `laser` | laser + its shots | no laser yet, or shots < 6 |
| `mines` | +2 mines | mines < 3 |

Random items appear every 6 s, starting 3 s into the match, at random free spots
(inside the safe zone once it shrinks). Spawning pauses while 6 spawned items are on the map.
Spawn weights: ammo 26, shield 18, health 18, gun 10, life 7, launcher 10, mines 15, laser 12.

### 5.12 Bushes
- Bushes are rectangles in `info.map.bushes`. They block nothing: players, bullets, grenades and
  explosions pass through them.
- A player whose **centre** is inside a bush is **hidden** from an enemy, unless:
  - the enemy is within **90 u** (centre to centre), or its centre is in the same bush, or
  - the hidden player **attacked or took damage in the last 1 s**, or
  - the hidden player is **exposed**: it has spent **5 s** in bushes without a break.
- **Hiding is limited.** Time in bushes adds up while your centre is in any bush (moving from one
  bush to another does not reset it). After 5 s you are exposed, visible to everyone for as
  long as you stay in a bush. Only **2 s outside all bushes** refills it; stepping out
  for a moment does not. `hideLeft` in each player's view shows the seconds left (0 = exposed).
- A hidden enemy stays in `state.players` with `visible: false`. Its `x`, `y`, `vx`, `vy` and
  `facing` are frozen at what you last saw, and `seenAgo` tells you how many seconds ago that was.
  Its hp, shield, lives and weapon stay visible, like a scoreboard.
- Hidden players can still be hit: aim at where you think they are.
- Bullets, grenades, mines, items and explosions are always visible, so shooting from a bush
  shows where the shots come from.
- You always see yourself.

### 5.13 Safe zone
- The safe zone is a circle around the **map centre**, described every tick in `state.zone`.
  Its radius follows a fixed schedule:
  1. Until 45 s it covers the whole map.
  2. It shrinks linearly for 105 s down to **200 u** (`finalRadius`).
  3. It holds that size for 15 s.
  4. It **collapses** linearly to radius 0 over 15 s, and stays closed. From then on
     everyone takes zone damage, so a match cannot stall at the end.
- At every whole second of match time, each living player whose **centre** is outside the zone
  takes **10 damage**. Shield absorbs it first, and invulnerability blocks it.
- Zone damage counts as noise, so it reveals a player hiding in a bush outside the zone
  ([§5.12](#512-bushes)).
- Dying to the zone gives nobody the kill. In `state.events` zone damage is a `hit` with
  `weapon: 'zone'` and `attackerId` equal to the damaged player's own id.
- A point is inside if `(x - zone.x)² + (y - zone.y)² <= radius²`. The countdowns
  `shrinkStartsIn`, `shrinkEndsIn`, `collapseStartsIn` and `collapseEndsIn` let you predict
  the radius; `zoneRadiusIn` in the example bot ([§12](#12-complete-example-bot)) does it.
- `zone.damagePerSecond` is `0` when a match turns the zone off; then it never hurts.

---

## 6. Types

These are the exact shapes you receive and return. They are TypeScript, for reference only;
write your bot in plain JavaScript.

```ts
// Harena bot API — the exact shapes a bot receives and returns.
//
// Conventions used everywhere below:
//   * Distances are world units (u). Origin (0, 0) is the TOP-LEFT corner of the map;
//     +x points right, +y points DOWN.
//   * Angles are radians, 0 = pointing right (+x), increasing CLOCKWISE on screen
//     (PI/2 = pointing down). This is exactly Math.atan2(dy, dx) for a vector (dx, dy).
//     Angles in the state are normalized to (-PI, PI]; you may return any finite angle.
//   * Speeds are u/s, times and timers are seconds.
//   * `players` is indexed by player id: state.players[id].id === id.

export type WeaponName = 'knife' | 'gun' | 'launcher' | 'laser';

export type ItemType = 'ammo' | 'shield' | 'health' | 'gun' | 'life' | 'launcher' | 'mines' | 'laser';

export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned wall rectangle: top-left corner (x, y), width w, height h. */
export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Passed once to init(). */
export interface InitInfo {
  /** Your player id. */
  selfId: number;
  /** Everyone in the match, in id order (including you). */
  players: { id: number; name: string }[];
  map: {
    id: string;
    name: string;
    width: number;
    height: number;
    /** Solid for players, bullets, grenades and explosions. The map edge is solid too. */
    walls: Wall[];
    /** Possible (re)spawn points. */
    spawns: Vec2[];
    /** Gun pads: a gun appears here at the start and refills some time after being taken. */
    gunSpawns: Vec2[];
    /** Bushes: enemies inside can be hidden from you (see the rules). They block nothing. */
    bushes: Wall[];
  };
  /** Every rule constant (same values as the tables in this document), e.g. rules.knife.damage. */
  rules: Record<string, any>;
  /** Match length in seconds, or 0 for no limit. */
  timeLimit: number;
}

export interface PlayerView {
  id: number;
  name: string;
  /**
   * false if this enemy is hidden from you in a bush. x, y, vx, vy and facing then
   * show what you saw last time it was visible (they are not updated while hidden).
   * You and your own data are always visible.
   */
  visible: boolean;
  /** Seconds since you last saw this player (0 while visible). */
  seenAgo: number;
  x: number;
  y: number;
  /** Actual velocity during the last tick, u/s. */
  vx: number;
  vy: number;
  /** Current facing in radians. Attacks go this way. It turns toward your `aim` at a capped rate. */
  facing: number;
  hp: number;
  shield: number;
  /** Lives left, including the current one. */
  lives: number;
  /** false while waiting to respawn or after elimination. */
  alive: boolean;
  /** true once all lives are gone (out of the match for good). */
  eliminated: boolean;
  /** Seconds until respawn while dead (0 when alive or eliminated). */
  respawnIn: number;
  /**
   * Seconds this player can still hide in bushes before being exposed (0 = exposed while in
   * a bush). Counts down while its centre is in any bush; refills after a break outside.
   * null if the match has no hiding limit.
   */
  hideLeft: number | null;
  /** Seconds of invulnerability left (0 = can be damaged). */
  invulnerable: number;
  /** Weapon in hand. */
  weapon: WeaponName;
  /** Weapons owned besides the knife (the knife is always owned). */
  hasGun: boolean;
  hasLauncher: boolean;
  hasLaser: boolean;
  /** Ammunition: gun bullets, launcher grenades and laser shots. */
  ammo: { gun: number; launcher: number; laser: number };
  /** Seconds until this player's charging laser fires (0 = not charging). See `lasers` in the state. */
  laserCharge: number;
  /** Mines carried. */
  mines: number;
  /** Seconds until each action is available again (0 = ready now). */
  cooldowns: {
    knife: number;
    gun: number;
    launcher: number;
    /** Until you can start charging the laser again (it starts after a shot fires). */
    laser: number;
    mine: number;
    /** Weapon switching: no attacks until this reaches 0. */
    switch: number;
  };
}

export interface BulletView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Constant velocity, u/s. */
  vx: number;
  vy: number;
  radius: number;
}

export interface GrenadeView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Distance left before it explodes on its own. */
  remainingRange: number;
}

export interface MineView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Seconds until it explodes. */
  fuse: number;
}

/**
 * A laser being charged: it fires along `path` when `charge` runs out. The direction is locked,
 * but the shooter can still move, so the whole line moves with them until it fires.
 */
export interface LaserView {
  ownerId: number;
  /** Seconds until it fires. */
  charge: number;
  /** Locked direction, radians. */
  angle: number;
  /**
   * Where the beam would go if it fired now from the shooter's current centre: the start, each
   * bounce point, then the end. It stops at the first player it touches (not shown here).
   */
  path: Vec2[];
}

/** An explosion that happened during the last tick. */
export interface ExplosionView {
  ownerId: number;
  source: 'grenade' | 'mine';
  x: number;
  y: number;
  radius: number;
}

/**
 * The safe zone: a circle around the map centre that shrinks during the match.
 * At every whole second, a player whose centre is outside it takes damage.
 */
export interface ZoneView {
  /** Centre (the map centre; it never moves). */
  x: number;
  y: number;
  /** Current radius. You are outside if the distance from (x, y) to your centre is greater. */
  radius: number;
  /** Radius at the end of the first shrink; the zone holds there, then collapses to 0. */
  finalRadius: number;
  /** Seconds until shrinking starts (0 once it has started). */
  shrinkStartsIn: number;
  /** Seconds until finalRadius is reached (0 once reached). The radius shrinks linearly. */
  shrinkEndsIn: number;
  /** Seconds until the collapse from finalRadius toward 0 starts (0 once started; null if it never collapses). */
  collapseStartsIn: number | null;
  /** Seconds until the radius reaches 0 (0 once reached; null if it never collapses). Linear. */
  collapseEndsIn: number | null;
  /** Damage per second outside the zone. 0 means the zone is off in this match. */
  damagePerSecond: number;
}

export interface ItemView {
  id: number;
  type: ItemType;
  x: number;
  y: number;
}

/** Things that happened during the last tick. */
export type EventView =
  | { type: 'shot'; playerId: number }
  | { type: 'swing'; playerId: number; hitIds: number[] }
  | { type: 'hit'; attackerId: number; targetId: number; weapon: WeaponName | 'explosion' | 'zone'; damage: number }
  /** A laser fired: its path (start, bounce points, end) and the player it hit, or null. */
  | { type: 'laser'; playerId: number; path: Vec2[]; hitId: number | null }
  | { type: 'death'; playerId: number; killerId: number; livesLeft: number }
  | { type: 'eliminated'; playerId: number }
  | { type: 'respawn'; playerId: number; x: number; y: number }
  | { type: 'pickup'; playerId: number; itemType: ItemType };

/** Passed to decide() every tick. A fresh copy each time: changing it has no effect. */
export interface BotState {
  /** Index of the tick being decided (0, 1, 2, ...). */
  tick: number;
  /** Seconds elapsed since the start. */
  time: number;
  /** Seconds left before the time limit, or null if there is no limit. */
  timeLeft: number | null;
  /** You (same object as players[selfId]). */
  self: PlayerView;
  /** Everyone, indexed by id, including you and dead / eliminated players. */
  players: PlayerView[];
  bullets: BulletView[];
  grenades: GrenadeView[];
  mines: MineView[];
  /** Lasers being charged (their warning lines). */
  lasers: LaserView[];
  explosions: ExplosionView[];
  items: ItemView[];
  events: EventView[];
  zone: ZoneView;
}

/**
 * Returned from decide(). Every field is optional; returning {} or null means
 * "stand still, keep facing, don't attack".
 */
export interface Action {
  /** Movement direction. Length is clamped to 1: {x:1,y:0} = full speed right, {x:0.5,y:0} = half speed. */
  move?: Vec2;
  /** Angle to turn toward, radians. Facing rotates toward it at most rules.player.turnRateDegrees per second. */
  aim?: number;
  /** Attack with the weapon in hand (ignored while on cooldown, switching, or out of ammo). */
  attack?: boolean;
  /** Switch to this weapon (ignored if you don't own it or already hold it). */
  weapon?: WeaponName;
  /** Plant a mine at your position (needs a carried mine and a ready mine cooldown). */
  plantMine?: boolean;
}
```

Notes:
- `state.players` includes **everyone** (you, dead and eliminated players), indexed by id.
  Check `alive` before targeting.
- `state.self` is the same data as `state.players[info.selfId]`.
- `state` is a fresh copy every tick, so modifying it does nothing.
- `state.events` lists what happened during the previous tick: hits, deaths, pickups, and so on.

---

## 7. Actions

```js
return {
  move: { x: 0.7, y: -0.7 }, // direction; length clamped to 1 (0,0 = stand still)
  aim: Math.PI / 2,          // turn toward this angle (radians)
  attack: true,              // use the weapon in hand
  weapon: 'gun',             // switch weapon
  plantMine: false,          // plant a mine here
};
```

- All fields are optional. `null`, `undefined` or `{}` means stand still, keep facing, and don't attack.
- Every field must have the right type: `move` must be `{x, y}` with finite numbers, `aim`
  a finite number, `attack`/`plantMine` booleans, and `weapon` one of the four names. **If any field
  is malformed, the whole action is rejected** and counts as a failure (see §8).
- Unknown extra fields are ignored. Speed, rate of fire and damage come only from the
  rules: out-of-range numbers are clamped, never trusted.

---

## 8. Sandbox, limits and failures

Each bot runs in its own isolated worker and only exchanges plain data with the game.

**Time limits**
- `init`: 1000 ms. `decide`: **10 ms per tick**, measured inside your worker.
  Aim for well under 1 ms: the example bot below needs only a few microseconds.
- A decide that takes longer than the budget is a **timeout**, and its result is discarded. While a
  slow `decide` is still running, your bot misses the following ticks. Those also count as timeouts.
- If your worker doesn't answer for 1000 ms (an infinite loop, for example), it is **terminated and
  restarted** with a fresh `init()`. All module state is lost. A **second hang disables the bot** for the
  rest of the match, and it stands still.

**Failures** (a timeout, an exception thrown from `decide`, or a malformed action)
- On a failure, the game repeats your **last valid action**, but without `plantMine`.
- After **5 consecutive failures** your player **stands still** until `decide` again returns a
  valid action in time.
- A file that fails to load, or doesn't export `decide`, is disabled for the whole match.

**Not available** (the file is rejected, or the call fails at runtime):
- network access: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`
- loading external code: `importScripts`
- spawning workers: `Worker`, `SharedWorker`
- cross-context messaging: `BroadcastChannel`, `MessageChannel`
- raw messaging with the host: `postMessage`
- storage: `indexedDB`, `localStorage`, `sessionStorage`, `caches`
- browser APIs: `navigator`
- the page (DOM): `document`
- the Node process: `process`
- runtime APIs: `Deno`, `Bun`
- native code: `WebAssembly`
- dynamic code execution: `eval`
- the global scope: `globalThis`
- running code outside decide(): `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `requestAnimationFrame`
- shared memory: `SharedArrayBuffer`, `Atomics`

Also not allowed: `import`/`require`, `eval` or `new Function`, modifying built-ins or prototypes
(for example `Math.random = …`), and async code (`async`/`await`/Promises). The file size limit is 200 KB.

**Available**
- All standard JavaScript: `Math`, `JSON`, arrays, `Map`/`Set`, classes, closures, and so on.
- `performance.now()` and `Date.now()`, if you want to budget your own time.
- `Math.random()` is available but **seeded per match and player**, so a match with the same seed
  replays identically. Don't rely on it being different between runs.
- `console.log` / `warn` / `error` go to the bot log in the viewer, up to 20 lines per tick.

---

## 9. All constants

Every value below is also available at runtime as `info.rules.<path>`, for example
`info.rules.knife.damage`.

**general**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `tickRate` | 30 | ticks/s | Simulation ticks per second. decide() is called once per tick. |

**player**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `player.radius` | 16 | u | Collision radius of every player (players are circles). |
| `player.speedKnife` | 210 | u/s | Maximum movement speed while holding the knife. |
| `player.speedGun` | 190 | u/s | Maximum movement speed while holding the gun. |
| `player.speedLauncher` | 180 | u/s | Maximum movement speed while holding the grenade launcher. |
| `player.speedLaser` | 190 | u/s | Maximum movement speed while holding the laser (also while charging it). |
| `player.accelTime` | 0.3 | s | Inertia: time to go from standing to top speed (or back). Velocity changes by at most topSpeed / accelTime per second (0 = instant). |
| `player.turnRateDegrees` | 540 | deg/s | Maximum rate at which facing rotates toward the requested aim angle. |
| `player.maxHp` | 100 | hp | Health at spawn and the health cap. |
| `player.maxShield` | 100 | shield | Shield cap. Shield absorbs damage before health. |
| `player.startShield` | 0 | shield | Shield at every spawn and respawn. |
| `player.startLives` | 3 | lives | Lives at match start (including the current one). |
| `player.maxLives` | 5 | lives | Lives cap; extra-life items are not picked up at the cap. |
| `player.switchTime` | 0.3 | s | After switching weapons you cannot attack for this long. |

**knife**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `knife.damage` | 35 | hp | Damage of one knife hit. |
| `knife.reach` | 36 | u | Reach beyond the attacker's edge: a target is in range if centre distance <= 2*radius + reach. |
| `knife.arcDegrees` | 100 | deg | Total width of the knife arc, centred on the attacker's facing. |
| `knife.cooldown` | 0.5 | s | Minimum time between knife swings. |

**gun**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `gun.damage` | 20 | hp | Damage of one bullet. |
| `gun.bulletSpeed` | 480 | u/s | Bullet speed (constant, straight line). |
| `gun.bulletRadius` | 4 | u | Bullet collision radius. |
| `gun.cooldown` | 0.35 | s | Minimum time between shots. |
| `gun.range` | 900 | u | Bullets disappear after travelling this far. |
| `gun.pickupAmmo` | 15 | bullets | Ammo gained from a gun item spawned by the map or the item spawner. |
| `gun.maxAmmo` | 40 | bullets | Ammo cap. |

**launcher**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `launcher.grenadeSpeed` | 480 | u/s | Grenade speed (constant, straight line). |
| `launcher.grenadeRadius` | 6 | u | Grenade collision radius. |
| `launcher.cooldown` | 1.2 | s | Minimum time between grenade shots. |
| `launcher.range` | 700 | u | A grenade explodes by itself after travelling this far. |
| `launcher.pickupAmmo` | 3 | grenades | Grenades gained from a launcher item. |
| `launcher.maxAmmo` | 6 | grenades | Grenade cap. |
| `launcher.blastRadius` | 80 | u | Grenade explosion radius (measured to the edge of a target). |
| `launcher.centerDamage` | 200 | hp | Grenade damage at the centre of the explosion. |
| `launcher.edgeDamage` | 20 | hp | Grenade damage at the edge of the blast radius (linear falloff in between). |

**laser**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `laser.chargeTime` | 0.75 | s | Warning time: the beam fires this long after you start charging (everyone sees the warning line meanwhile). |
| `laser.damage` | 60 | hp | Damage of a laser hit. |
| `laser.cooldown` | 1.5 | s | After a laser fires, you cannot start charging again for this long. |
| `laser.range` | 2000 | u | Total beam length, including the part after a bounce. |
| `laser.bounces` | 1 | bounces | How many times the beam reflects off walls (and the map edge) before it ends. |
| `laser.beamRadius` | 3 | u | Beam half-width: it hits a player whose centre is within player radius + this of the beam's line. |
| `laser.pickupAmmo` | 3 | shots | Laser shots gained from a laser item. |
| `laser.maxAmmo` | 6 | shots | Laser shot cap. |

**mines**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `mines.fuse` | 2.5 | s | A planted mine explodes this long after being planted. |
| `mines.plantCooldown` | 0.5 | s | Minimum time between planting two mines. |
| `mines.pickupAmount` | 2 | mines | Mines gained from a mines item. |
| `mines.maxCarry` | 3 | mines | Maximum mines carried. |
| `mines.blastRadius` | 100 | u | Mine explosion radius (measured to the edge of a target). |
| `mines.centerDamage` | 200 | hp | Mine damage at the centre of the explosion. |
| `mines.edgeDamage` | 25 | hp | Mine damage at the edge of the blast radius (linear falloff in between). |

**explosions**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `explosions.selfDamageFactor` | 1 | x | Multiplier for damage you take from your own explosions (1 = full damage). |

**bushes**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `bushes.revealDistance` | 90 | u | An enemy in a bush is visible to you if the centres are at most this far apart. |
| `bushes.noiseRevealTime` | 1 | s | A player in a bush stays visible this long after attacking or taking damage. |
| `bushes.hideLimit` | 5 | s | After this long in bushes without a break you are exposed: visible to everyone while in a bush (0 = no limit). |
| `bushes.rehideTime` | 2 | s | You must stay out of all bushes this long before you can hide again (the hide limit refills). |

**zone**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `zone.shrinkStart` | 45 | s | Match time at which the safe zone starts shrinking (before that it covers the whole map). |
| `zone.shrinkDuration` | 105 | s | The zone radius shrinks linearly to its final size over this long. |
| `zone.finalRadius` | 200 | u | Radius at the end of the first shrink. Its centre is the map centre. |
| `zone.holdTime` | 15 | s | The zone then stays at finalRadius for this long. |
| `zone.collapseDuration` | 15 | s | Then it shrinks linearly from finalRadius to 0 over this long (0 = it never collapses). |
| `zone.damagePerSecond` | 10 | hp | Damage taken at every whole second of match time while your centre is outside the zone (0 = zone off). |

**respawn**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `respawn.delay` | 2 | s | Time between losing a life and respawning. |
| `respawn.invulnerability` | 1.5 | s | Invulnerability after (re)spawning; ends early when you attack. |
| `respawn.safeDistance` | 300 | u | Respawn picks a random spawn point at least this far from every living enemy (else the farthest one). |

**items**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `items.radius` | 12 | u | Pickup radius of items: picked up when centre distance <= player radius + item radius. |
| `items.firstSpawnDelay` | 3 | s | Time before the first random item spawns. |
| `items.spawnInterval` | 6 | s | Time between random item spawns. |
| `items.maxOnMap` | 6 | items | Random spawning pauses while this many random items are on the map. |
| `items.gunPadRespawn` | 20 | s | A map gun pad refills this long after its gun is taken. |
| `items.ammoAmount` | 10 | bullets | Ammo from an ammo item (only picked up if you hold a gun and are below max ammo). |
| `items.shieldAmount` | 50 | shield | Shield from a shield item (only picked up below max shield). |
| `items.healthAmount` | 40 | hp | Health from a health item (only picked up below max health). |
| `items.lifeAmount` | 1 | lives | Lives from an extra-life item (only picked up below max lives). |
| `items.weights.ammo` | 26 | weight | Relative spawn weight of ammo items. |
| `items.weights.shield` | 18 | weight | Relative spawn weight of shield items. |
| `items.weights.health` | 18 | weight | Relative spawn weight of health items. |
| `items.weights.gun` | 10 | weight | Relative spawn weight of gun items. |
| `items.weights.life` | 7 | weight | Relative spawn weight of extra-life items. |
| `items.weights.launcher` | 10 | weight | Relative spawn weight of grenade launcher items. |
| `items.weights.mines` | 15 | weight | Relative spawn weight of mines items. |
| `items.weights.laser` | 12 | weight | Relative spawn weight of laser items. |

**match**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `match.defaultTimeLimit` | 180 | s | Default match length (the match setup may change it). |
| `match.minPlayers` | 1 | players | Minimum players in a match. |
| `match.maxPlayers` | 8 | players | Maximum players in a match. |

**sandbox**

| `info.rules.…` | Value | Unit | Meaning |
|---|---|---|---|
| `sandbox.initBudgetMs` | 1000 | ms | Time budget for init(). |
| `sandbox.decideBudgetMs` | 10 | ms | Time budget for one decide() call. |
| `sandbox.graceMs` | 40 | ms | Extra wall-clock wait for message passing before a reply counts as late. |
| `sandbox.hangLimitMs` | 1000 | ms | A bot silent for this long is terminated and restarted once; a second hang disables it. |
| `sandbox.failureStreakLimit` | 5 | ticks | After this many consecutive failures (timeout, exception, invalid action) the bot stands still until it recovers. |
| `sandbox.workerStartMs` | 15000 | ms | Time for the sandbox worker itself to start (e.g. download on a slow network), before your bot's code is loaded; doesn't count toward any budget. |

---

## 10. Maps

Your bot receives the map in `info.map` and should work on any of them.

| id | Name | Size | Walls | Bushes | Spawns | Gun pads |
|---|---|---|---|---|---|---|
| `blocks` | Blockyard | 1600 × 1000 | 15 | 4 | 8 | 2 |
| `corridors` | Corridors | 1400 × 1000 | 13 | 4 | 8 | 2 |
| `duel` | Duel | 1000 × 700 | 3 | 2 | 8 | 2 |
| `open` | Open Field | 1600 × 1000 | 7 | 4 | 8 | 2 |

---

## 11. Tips

- **Turn before attacking.** Attacks use your *current* facing, and turning is capped at
  18° per tick. Check `Math.abs(angleDiff(aim, me.facing))` before attacking.
- **Lead moving targets.** A bullet takes `distance / 480` s to arrive, so aim at
  `target + velocity × that time`.
- **Dodge sideways, early.** Bullets are only about 2.3× faster than you, so stepping perpendicular to an
  incoming bullet's path usually avoids it, but inertia means you must start moving a few
  ticks before it arrives. Likewise, enemies can't swerve instantly: leading your shots pays off.
- **Check line of sight** against `info.map.walls` before shooting (a segment-vs-rectangle test).
- **Walk around walls.** Walking straight at a target behind a wall pins you against it
  forever (a common way for bots to stall). If the straight path is blocked, head for a corner
  of the blocking wall first; `pathTo` in the example bot shows a simple way.
- **Detect being stuck.** If you ask to move but `self.vx/vy` is near 0, a wall is in the way.
- **Don't camp.** Bushes are for ambushes and breaking line of sight, not for waiting out the match:
  after 5 s you are exposed. Watch `self.hideLeft`, and watch an enemy's `hideLeft` to
  know when it will show up.
- **Mind the zone.** Head for the centre before `state.zone` reaches you. Bots that hide or wait
  for the time limit get pushed out, take damage every second, and are revealed in bushes.
  Once it collapses, the fight is on: whoever wins before the damage adds up takes the match.
- Keep `decide` cheap. It runs 30 times per second, next to up to 7 other bots.
- **Optional: try it on the real engine.** If you can run JavaScript (Node.js 18 or newer), you can
  download the test kit from <https://harena.rcwalter.net/harena-sim.mjs> (or build it from the
  source, <https://github.com/rcwalter24/harena>, with `npm run build`): the actual engine, rules
  and sandbox in one file, with the built-in bots as opponents. For example
  `node harena-sim.mjs mybot.js --vs gunner,chaser --games 20` prints win rates, accuracy and any
  errors or timeouts; `--trace trace.json` records one game tick by tick; `--help` lists the rest.
  It's a convenience, not a requirement — a bot written from this document alone is fine.

Useful helpers:

```js
// Signed shortest difference between two angles, in (-PI, PI].
function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

// True if the segment (x0,y0)→(x1,y1) crosses no wall (slab test per rectangle).
function lineOfSight(x0, y0, x1, y1, walls) {
  return !walls.some((r) => {
    let t0 = 0, t1 = 1;
    const d = [x1 - x0, y1 - y0], p = [x0, y0], lo = [r.x, r.y], hi = [r.x + r.w, r.y + r.h];
    for (let i = 0; i < 2; i++) {
      if (d[i] === 0) { if (p[i] < lo[i] || p[i] > hi[i]) return false; continue; }
      let a = (lo[i] - p[i]) / d[i], b = (hi[i] - p[i]) / d[i];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    return true;
  });
}
```

---

## 12. Complete example bot

This bot picks up a gun, keeps its distance, strafes, leads its shots, dodges bullets, and
knifes anyone who gets too close while it is unarmed.

```js
// Gunner: grabs weapons, keeps its distance, leads its shots and dodges projectiles.
// Uses the gun first, the grenade launcher when out of bullets, drops mines on chasers,
// falls back to the knife when unarmed and an enemy gets close, and stays inside the safe zone.
export const meta = { name: 'Gunner', author: 'Harena examples' };

let rules = null;
let walls = [];
let mapSize = { w: 0, h: 0 };
let strafeSign = 1;
let strafeFlipAt = 0;

export function init(info) {
  rules = info.rules;
  walls = info.map.walls;
  mapSize = { w: info.map.width, h: info.map.height };
}

// ---------- geometry helpers ----------

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

// Does the segment (x0,y0)→(x1,y1) cross the rectangle grown by `pad`? (slab test)
function segmentHitsRect(x0, y0, x1, y1, r, pad) {
  let tMin = 0;
  let tMax = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [r.x - pad, r.y - pad];
  const hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (d[i] === 0) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
    } else {
      let t1 = (lo[i] - p[i]) / d[i];
      let t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

function clearShot(a, b, pad) {
  return !walls.some((w) => segmentHitsRect(a.x, a.y, b.x, b.y, w, pad));
}

// ---------- navigation ----------

// Can we walk the straight line from a to b without clipping a wall?
function walkable(a, b) {
  return !walls.some((w) => segmentHitsRect(a.x, a.y, b.x, b.y, w, rules.player.radius - 2));
}

// Unit direction for walking toward `goal`. If a wall is in the way, head for the corner of
// that wall (pushed out past our radius) on the shortest way round it. A corner that still
// can't see the goal is costed via a second corner, so we don't dither between corners.
function pathTo(me, goal) {
  const straight = normalize({ x: goal.x - me.x, y: goal.y - me.y });
  if (walkable(me, goal)) return straight;
  const r = rules.player.radius;
  const blocker = walls
    .filter((w) => segmentHitsRect(me.x, me.y, goal.x, goal.y, w, r - 2))
    .sort((a, b) => dist(me, { x: a.x + a.w / 2, y: a.y + a.h / 2 }) - dist(me, { x: b.x + b.w / 2, y: b.y + b.h / 2 }))[0];
  const m = r + 10;
  const corners = [
    { x: blocker.x - m, y: blocker.y - m },
    { x: blocker.x + blocker.w + m, y: blocker.y - m },
    { x: blocker.x - m, y: blocker.y + blocker.h + m },
    { x: blocker.x + blocker.w + m, y: blocker.y + blocker.h + m },
  ].filter((c) => c.x > r && c.y > r && c.x < mapSize.w - r && c.y < mapSize.h - r);
  // Remaining distance from a corner to the goal, going via one more corner if needed.
  const onward = (c) => {
    if (walkable(c, goal)) return dist(c, goal);
    let best = 1e4;
    for (const c2 of corners) {
      if (c2 !== c && walkable(c, c2) && walkable(c2, goal)) best = Math.min(best, dist(c, c2) + dist(c2, goal));
    }
    return best;
  };
  let best = null;
  let bestCost = Infinity;
  for (const c of corners) {
    if (dist(c, me) <= 8) continue; // already there
    const cost = dist(me, c) + onward(c) + (walkable(me, c) ? 0 : 1e4);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best ? normalize({ x: best.x - me.x, y: best.y - me.y }) : straight;
}

// ---------- threat avoidance ----------

// Sideways push away from bullets and grenades that will pass close to us within ~1 s.
function dodgeVector(state, me) {
  let dx = 0;
  let dy = 0;
  const projectiles = [
    ...state.bullets.map((b) => ({ ...b, danger: rules.player.radius + b.radius + 12 })),
    // Grenades explode on contact, so give them a much wider berth.
    ...state.grenades.map((g) => ({ ...g, danger: rules.launcher.blastRadius + rules.player.radius })),
  ];
  for (const b of projectiles) {
    if (b.ownerId === me.id) continue;
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / speed;
    const uy = b.vy / speed;
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * ux + ry * uy; // distance ahead of the projectile
    if (along < 0 || along > speed) continue;
    const side = rx * -uy + ry * ux; // signed perpendicular offset
    if (Math.abs(side) > b.danger) continue;
    const s = side >= 0 ? 1 : -1;
    const weight = 1 - along / speed;
    dx += -uy * s * weight;
    dy += ux * s * weight;
  }
  return { x: dx, y: dy };
}

// Push away from mines that will explode soon and would reach us (including our own).
function mineEscape(state, me) {
  let dx = 0;
  let dy = 0;
  const reach = rules.mines.blastRadius + rules.player.radius + 20;
  for (const m of state.mines) {
    const d = dist(m, me);
    if (d > reach || m.fuse > 1.5) continue;
    const away = d > 1e-6 ? { x: (me.x - m.x) / d, y: (me.y - m.y) / d } : { x: 1, y: 0 };
    const urgency = 1 + (1.5 - m.fuse);
    dx += away.x * urgency;
    dy += away.y * urgency;
  }
  return { x: dx, y: dy };
}

// Zone radius `t` seconds from now: it shrinks linearly to finalRadius, holds, then
// collapses linearly to 0.
function zoneRadiusIn(zone, t) {
  if (zone.collapseStartsIn !== null && t >= zone.collapseStartsIn) {
    const collapseTime = zone.collapseEndsIn - zone.collapseStartsIn;
    const from = zone.collapseStartsIn > 0 ? zone.finalRadius : zone.radius;
    return collapseTime <= 0 || t >= zone.collapseEndsIn ? 0 : from * (1 - (t - zone.collapseStartsIn) / collapseTime);
  }
  const shrinkTime = zone.shrinkEndsIn - zone.shrinkStartsIn;
  if (shrinkTime <= 0) return zone.radius;
  const elapsed = Math.max(0, t - zone.shrinkStartsIn);
  return zone.radius - (zone.radius - zone.finalRadius) * Math.min(1, elapsed / shrinkTime);
}

// Pull toward the zone centre when we are outside the zone, or will be within 3 s.
function zonePull(state, me) {
  const zone = state.zone;
  if (zone.damagePerSecond === 0) return { x: 0, y: 0 };
  const d = dist(me, zone);
  const slack = zoneRadiusIn(zone, 3) - rules.player.radius - 30 - d;
  if (slack > 0 || d < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(3, 0.5 - slack / 50);
  const dir = pathTo(me, zone);
  return { x: dir.x * k, y: dir.y * k };
}

// ---------- decision ----------

// Nearest living enemy, preferring ones we can see (hidden ones only have a stale position).
function nearestEnemy(state, me) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = dist(p, me) + (p.visible ? 0 : 400);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Items worth walking to right now, nearest first.
function wantedItems(state, me) {
  const useful = (it) =>
    (it.type === 'gun' && (!me.hasGun || me.ammo.gun < rules.gun.maxAmmo)) ||
    (it.type === 'ammo' && me.hasGun && me.ammo.gun < rules.gun.maxAmmo) ||
    (it.type === 'launcher' && (!me.hasLauncher || me.ammo.launcher < rules.launcher.maxAmmo)) ||
    (it.type === 'mines' && me.mines < rules.mines.maxCarry) ||
    (it.type === 'health' && me.hp < rules.player.maxHp * 0.7) ||
    (it.type === 'shield' && me.shield < rules.player.maxShield) ||
    (it.type === 'life' && me.lives < rules.player.maxLives);
  const zoneSoon = zoneRadiusIn(state.zone, 3) - 20;
  const safe = (it) => state.zone.damagePerSecond === 0 || dist(it, state.zone) < zoneSoon;
  return state.items.filter((it) => useful(it) && safe(it)).sort((a, b) => dist(a, me) - dist(b, me));
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;
  const enemy = nearestEnemy(state, me);
  const dodge = dodgeVector(state, me);
  const escape = mineEscape(state, me);
  const zone = zonePull(state, me);
  const avoid = { x: dodge.x * 2 + escape.x * 3 + zone.x, y: dodge.y * 2 + escape.y * 3 + zone.y };
  const items = wantedItems(state, me);

  const weapon = me.hasGun && me.ammo.gun > 0 ? 'gun' : me.hasLauncher && me.ammo.launcher > 0 ? 'launcher' : 'knife';

  // 1) Unarmed: go for items, knife anyone who gets close.
  if (weapon === 'knife') {
    const reach = 2 * rules.player.radius + rules.knife.reach;
    const wanted = items[0];
    if (enemy && (!wanted || dist(enemy, me) < reach + 30)) {
      const angle = Math.atan2(enemy.y - me.y, enemy.x - me.x);
      const toward = pathTo(me, enemy);
      return {
        move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }),
        aim: angle,
        attack: dist(enemy, me) <= reach && Math.abs(angleDiff(angle, me.facing)) < 0.6,
        weapon: 'knife',
      };
    }
    if (wanted) {
      const toward = pathTo(me, wanted);
      return { move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }), aim: Math.atan2(toward.y, toward.x), weapon: 'knife' };
    }
    return { move: normalize(avoid), weapon: 'knife' };
  }

  if (!enemy) {
    const wanted = items[0];
    const toward = wanted ? pathTo(me, wanted) : { x: 0, y: 0 };
    return { move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }), weapon };
  }

  // 2) Armed: keep ~320 u away, strafe sideways, grab nearby items, and lead the target.
  const d = dist(enemy, me);
  const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });
  const radial = d > 380 ? 1 : d < 260 ? -1 : 0;
  if (state.time >= strafeFlipAt) {
    strafeSign = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = state.time + 0.8 + Math.random();
  }
  // Bumped into something? Flip the strafe direction.
  if (Math.hypot(me.vx, me.vy) < 40 && state.time > 0.3) strafeSign = -strafeSign;
  const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };
  const nearbyItem = items.find((it) => dist(it, me) < 150 && walkable(me, it));
  const detour = nearbyItem ? normalize({ x: nearbyItem.x - me.x, y: nearbyItem.y - me.y }) : { x: 0, y: 0 };

  // No line of fire: walk around the wall instead of strafing behind it.
  const inSight = clearShot(me, enemy, rules.gun.bulletRadius);
  const around = inSight ? null : pathTo(me, enemy);
  const move = around
    ? normalize({ x: around.x + avoid.x, y: around.y + avoid.y })
    : normalize({
      x: toward.x * radial + strafe.x * 0.7 + detour.x + avoid.x,
      y: toward.y * radial + strafe.y * 0.7 + detour.y + avoid.y,
    });

  // Aim where the enemy will be when the projectile arrives.
  const speed = weapon === 'gun' ? rules.gun.bulletSpeed : rules.launcher.grenadeSpeed;
  const flight = d / speed;
  const lead = { x: enemy.x + enemy.vx * flight, y: enemy.y + enemy.vy * flight };
  const aim = Math.atan2(lead.y - me.y, lead.x - me.x);
  const onTarget = Math.abs(angleDiff(aim, me.facing)) < 0.08;

  // Only shoot at hidden enemies we saw a moment ago; older positions are guesses.
  const fresh = enemy.visible || enemy.seenAgo < 0.5;
  let attack = false;
  if (me.weapon === weapon && onTarget && fresh) {
    if (weapon === 'gun') {
      attack = d < rules.gun.range * 0.8 && clearShot(me, lead, rules.gun.bulletRadius);
    } else {
      // Never fire a grenade close enough to catch ourselves in the blast.
      const safe = rules.launcher.blastRadius + rules.player.radius + 40;
      attack = d > safe && d < rules.launcher.range && clearShot(me, lead, rules.launcher.grenadeRadius);
    }
  }

  // An enemy is chasing us down: leave a mine behind (mineEscape then walks us away from it).
  const plantMine = me.mines > 0 && d < 120 && me.cooldowns.mine === 0 && !state.mines.some((m) => dist(m, me) < 150);

  return { move, aim, attack, weapon, plantMine };
}
```
