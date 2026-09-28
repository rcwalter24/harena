# Harena Bot API

{{GENERATED_NOTICE}}

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
- `decide(state)` runs **{{tickRate}} times per second**. It receives the full game state and
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

- Matches have {{match.minPlayers}}–{{match.maxPlayers}} players. It is **free-for-all**: everyone else is an enemy.
  The same bot file may appear several times; each copy runs separately and cannot
  talk to the others.
- Everyone starts with **{{player.startLives}} lives**, {{player.maxHp}} hp, {{player.startShield}} shield and only a **knife**.
- When hp reaches 0 you lose a life. If you have lives left, you respawn after
  {{respawn.delay}} s. With no lives left you are **eliminated**.
- **The last player not eliminated wins.** If the time limit (default {{match.defaultTimeLimit}} s,
  `info.timeLimit`) runs out first, survivors are ranked by lives left, then by hp + shield.
  Eliminated players rank below all survivors, and a later elimination ranks higher.
  Exact ties share a rank.
- **The safe zone shrinks.** From {{zone.shrinkStart}} s the playable area closes in on the map centre, and
  standing outside it hurts ([§5.12](#512-safe-zone)). Hiding or waiting out the clock does not work.
- You see the whole map and everything on it. The only exception is enemies hiding in
  **bushes** ([§5.11](#511-bushes)).

---

## 3. Coordinates, angles, units

- Distances are world units (u). The map spans `x ∈ [0, width]`, `y ∈ [0, height]`,
  with the origin at the **top-left** corner. **+x is right, +y is down.**
- Angles are radians. `0` points right (+x), and angles **increase clockwise on screen**:
  `π/2` points down (+y). This is exactly `Math.atan2(dy, dx)` for a vector `(dx, dy)`.
  Angles in the state are normalized to (−π, π]. You may return any finite angle.
- The unit vector for angle `a` is `(Math.cos(a), Math.sin(a))`.
- Speeds are u/s and times are seconds. One tick is 1/{{tickRate}} s ≈ {{derived.tickMs}} ms.
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
4. **Attacks**: knife swings hit instantly, and new bullets/grenades start at your centre.
5. **Projectiles** move along their path (bullets, then grenades), hitting walls or players.
6. **Mines** whose fuse ran out explode, then **explosions** deal damage.
7. **Zone damage** (on whole seconds) to players outside the safe zone.
8. **Deaths**: lives are lost, gear is dropped, kills are credited.
9. **Pickups**.
10. **Respawns**, and gun pads refill.
11. **Cooldowns** count down.

Consequences:
- Your action always reacts to state that is one tick old.
- Cooldowns in the state are **seconds until ready**, and `0` means you can act *this* tick.
  Durations are whole ticks: a cooldown of `c` seconds lasts `round(c × {{tickRate}})` ticks.
- Damage from different sources in the same tick all lands. A player at 0 hp takes
  no more damage that tick, so the kill goes to whoever brought them to 0 first.

---

## 5. Rules

### 5.1 Movement and facing
- `move` is a direction vector. Its length is clamped to 1 and multiplies your weapon's
  top speed: knife {{player.speedKnife}} u/s, gun {{player.speedGun}} u/s, launcher {{player.speedLauncher}} u/s.
  There is no acceleration: velocity changes instantly.
- Players are circles of radius **{{player.radius}}**. Walls push you out along their surface, so you
  slide along them. Players can't overlap: overlapping players are pushed apart equally.
- `state.self.vx/vy` is your *actual* velocity last tick. It is near 0 when you are
  pushing into a wall.
- Your **facing** turns toward `aim` by at most **{{player.turnRateDegrees}}°/s** ({{derived.turnPerTick}}° per tick),
  taking the shorter way round. If you omit `aim`, facing stays where it is. **Attacks
  always go in your current facing, not in your `aim`**, so turn first, then attack.

### 5.2 Health, shield, invulnerability
- Max hp is {{player.maxHp}} and max shield is {{player.maxShield}}. **Shield absorbs damage first**, and the
  remainder hits hp.
- After (re)spawning you are invulnerable for {{respawn.invulnerability}} s (`invulnerable` > 0). The
  invulnerability **ends as soon as you attack or plant a mine**. Projectiles still stop on invulnerable
  players but do no damage.

### 5.3 Knife (always owned)
- Damage **{{knife.damage}}**, cooldown **{{knife.cooldown}} s**.
- A swing hits **every** enemy at once whose centre is within **{{derived.knifeRange}} u** of your centre
  (= 2 × radius + reach {{knife.reach}}), and within **±{{derived.knifeHalfArc}}°** of your facing (the angle is measured to
  the enemy's centre), with no wall on the straight line between the two centres.

### 5.4 Gun
- You start without one. Pick up a `gun` item: map gun pads hold one at the start and
  refill {{items.gunPadRespawn}} s after being emptied.
- Each shot uses 1 ammo and fires a bullet from your centre along your facing. Cooldown is
  **{{gun.cooldown}} s**, damage **{{gun.damage}}**.
- Bullets fly straight at **{{gun.bulletSpeed}} u/s** ({{derived.bulletPerTick}} u per tick, about {{derived.bulletVsPlayer}}× player speed,
  so they can be dodged). They have radius {{gun.bulletRadius}} and range {{gun.range}} u.
- A bullet stops at the first thing on its path: a wall (the bullet radius counts), or a player
  other than its shooter. A player is hit if the path comes within {{derived.bulletHitRadius}} u
  (player radius + bullet radius) of their centre. Bullets never hit their shooter. Bullets
  keep flying after their shooter dies.
- A gun item gives the gun (if you lack it) plus its ammo, up to {{gun.maxAmmo}}. Pad and spawned
  guns carry {{gun.pickupAmmo}}, and dropped guns carry what their owner had.

### 5.5 Grenade launcher
- Picked up as a `launcher` item, which gives {{launcher.pickupAmmo}} grenades (max {{launcher.maxAmmo}}).
- It fires a grenade from your centre along your facing: speed {{launcher.grenadeSpeed}} u/s,
  radius {{launcher.grenadeRadius}}, cooldown {{launcher.cooldown}} s.
- The grenade explodes when it touches a wall or any player other than its shooter, or after
  flying {{launcher.range}} u.
- Explosion radius is {{launcher.blastRadius}} u. Damage is {{launcher.centerDamage}} at the centre and falls linearly to
  {{launcher.edgeDamage}} at the edge. Distance is measured from the blast centre to the nearest point of the target
  (centre distance − {{player.radius}}).

### 5.6 Mines
- Picked up as a `mines` item, which gives +{{mines.pickupAmount}} (carry at most {{mines.maxCarry}}).
- `plantMine: true` plants one at your position, whatever weapon you hold, even while switching.
  Cooldown is {{mines.plantCooldown}} s.
- A mine explodes **{{mines.fuse}} s after being planted**, no matter who is nearby. Everyone can see mines
  and their remaining `fuse`. Radius is {{mines.blastRadius}} u, damage {{mines.centerDamage}} at the centre falling to {{mines.edgeDamage}} at the edge.
- An explosion **immediately detonates every other mine in its radius** (chain reaction).
- Mines don't block movement. They outlive their owner, and kills still go to the owner.

### 5.7 Explosions
- Walls block explosions: a player takes no damage if a wall is on the straight line
  from the blast centre to their centre.
- **Your own explosions hurt you** (×{{explosions.selfDamageFactor}} damage). Dying to your own explosive is a suicide,
  so nobody gets the kill.
- Damage is rounded to whole points. Several explosions in the same tick all apply.
- In `state.events`, explosion damage shows up as `weapon: 'explosion'`. `state.explosions` lists
  every blast from the previous tick.

### 5.8 Weapon switching
- Return `weapon: 'knife' | 'gun' | 'launcher'` to switch; you must own the weapon. The new weapon's
  speed applies at once, but you **cannot attack for {{player.switchTime}} s** (`cooldowns.switch`).
- Requesting the weapon you already hold does nothing, so it is safe to send every tick.

### 5.9 Death, respawn, kills
- At 0 hp you lose a life. Your gun (if it has ammo) and your launcher (if it has grenades)
  drop where you died as items that keep their ammo. Carried mines drop as a `mines` item.
- You respawn after {{respawn.delay}} s with full hp, {{player.startShield}} shield and only the knife. The spawn point is
  random among spawn points at least {{respawn.safeDistance}} u from every living enemy, or the farthest one if
  none qualifies. Once the safe zone shrinks, only spawn points inside it count; if none is left,
  you respawn at a free spot inside the zone, as far from enemies as possible.
- A kill is credited to the last *other* player who damaged you in that life.

### 5.10 Items
Items are circles of radius {{items.radius}}. You pick one up when your centre is within
**{{derived.pickupReach}} u** of it (player radius + item radius). If several players touch it, the closest one gets it.
**Items you can't use stay on the ground**: full hp, full shield, max ammo, and so on.

| Item | Effect | Picked up only if |
|---|---|---|
| `health` | +{{items.healthAmount}} hp | hp < {{player.maxHp}} |
| `shield` | +{{items.shieldAmount}} shield | shield < {{player.maxShield}} |
| `life` | +{{items.lifeAmount}} life | lives < {{player.maxLives}} |
| `ammo` | +{{items.ammoAmount}} gun ammo | you have a gun and ammo < {{gun.maxAmmo}} |
| `gun` | gun + its ammo | no gun yet, or gun ammo < {{gun.maxAmmo}} |
| `launcher` | launcher + its grenades | no launcher yet, or grenades < {{launcher.maxAmmo}} |
| `mines` | +{{mines.pickupAmount}} mines | mines < {{mines.maxCarry}} |

Random items appear every {{items.spawnInterval}} s, starting {{items.firstSpawnDelay}} s into the match, at random free spots
(inside the safe zone once it shrinks). Spawning pauses while {{items.maxOnMap}} spawned items are on the map.
Spawn weights: {{derived.itemWeights}}.

### 5.11 Bushes
- Bushes are rectangles in `info.map.bushes`. They block nothing: players, bullets, grenades and
  explosions pass through them.
- A player whose **centre** is inside a bush is **hidden** from an enemy, unless:
  - the enemy is within **{{bushes.revealDistance}} u** (centre to centre), or its centre is in the same bush, or
  - the hidden player **attacked or took damage in the last {{bushes.noiseRevealTime}} s**.
- A hidden enemy stays in `state.players` with `visible: false`. Its `x`, `y`, `vx`, `vy` and
  `facing` are frozen at what you last saw, and `seenAgo` tells you how many seconds ago that was.
  Its hp, shield, lives and weapon stay visible, like a scoreboard.
- Hidden players can still be hit: aim at where you think they are.
- Bullets, grenades, mines, items and explosions are always visible, so shooting from a bush
  shows where the shots come from.
- You always see yourself.

### 5.12 Safe zone
- The safe zone is a circle around the **map centre**, described every tick in `state.zone`.
  Its radius follows a fixed schedule:
  1. Until {{zone.shrinkStart}} s it covers the whole map.
  2. It shrinks linearly for {{zone.shrinkDuration}} s down to **{{zone.finalRadius}} u** (`finalRadius`).
  3. It holds that size for {{zone.holdTime}} s.
  4. It **collapses** linearly to radius 0 over {{zone.collapseDuration}} s, and stays closed. From then on
     everyone takes zone damage, so a match cannot stall at the end.
- At every whole second of match time, each living player whose **centre** is outside the zone
  takes **{{zone.damagePerSecond}} damage**. Shield absorbs it first, and invulnerability blocks it.
- Zone damage counts as noise, so it reveals a player hiding in a bush outside the zone
  ([§5.11](#511-bushes)).
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
{{API_TYPES}}
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
  a finite number, `attack`/`plantMine` booleans, and `weapon` one of the three names. **If any field
  is malformed, the whole action is rejected** and counts as a failure (see §8).
- Unknown extra fields are ignored. Speed, rate of fire and damage come only from the
  rules: out-of-range numbers are clamped, never trusted.

---

## 8. Sandbox, limits and failures

Each bot runs in its own isolated worker and only exchanges plain data with the game.

**Time limits**
- `init`: {{sandbox.initBudgetMs}} ms. `decide`: **{{sandbox.decideBudgetMs}} ms per tick**, measured inside your worker.
  Aim for well under 1 ms: the example bot below needs only a few microseconds.
- A decide that takes longer than the budget is a **timeout**, and its result is discarded. While a
  slow `decide` is still running, your bot misses the following ticks. Those also count as timeouts.
- If your worker doesn't answer for {{sandbox.hangLimitMs}} ms (an infinite loop, for example), it is **terminated and
  restarted** with a fresh `init()`. All module state is lost. A **second hang disables the bot** for the
  rest of the match, and it stands still.

**Failures** (a timeout, an exception thrown from `decide`, or a malformed action)
- On a failure, the game repeats your **last valid action**, but without `plantMine`.
- After **{{sandbox.failureStreakLimit}} consecutive failures** your player **stands still** until `decide` again returns a
  valid action in time.
- A file that fails to load, or doesn't export `decide`, is disabled for the whole match.

**Not available** (the file is rejected, or the call fails at runtime):
{{FORBIDDEN_LIST}}

Also not allowed: `import`/`require`, `eval` or `new Function`, modifying built-ins or prototypes
(for example `Math.random = …`), and async code (`async`/`await`/Promises). The file size limit is {{derived.maxSourceKb}} KB.

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

{{CONSTANTS_TABLE}}

---

## 10. Maps

Your bot receives the map in `info.map` and should work on any of them.

{{MAPS_TABLE}}

---

## 11. Tips

- **Turn before attacking.** Attacks use your *current* facing, and turning is capped at
  {{derived.turnPerTick}}° per tick. Check `Math.abs(angleDiff(aim, me.facing))` before attacking.
- **Lead moving targets.** A bullet takes `distance / {{gun.bulletSpeed}}` s to arrive, so aim at
  `target + velocity × that time`.
- **Dodge sideways.** Bullets are only about {{derived.bulletVsPlayer}}× faster than you, so stepping perpendicular to an
  incoming bullet's path usually avoids it.
- **Check line of sight** against `info.map.walls` before shooting (a segment-vs-rectangle test).
- **Walk around walls.** Walking straight at a target behind a wall pins you against it
  forever (a common way for bots to stall). If the straight path is blocked, head for a corner
  of the blocking wall first; `pathTo` in the example bot shows a simple way.
- **Detect being stuck.** If you ask to move but `self.vx/vy` is near 0, a wall is in the way.
- **Mind the zone.** Head for the centre before `state.zone` reaches you. Bots that hide or wait
  for the time limit get pushed out, take damage every second, and are revealed in bushes.
  Once it collapses, the fight is on: whoever wins before the damage adds up takes the match.
- Keep `decide` cheap. It runs {{tickRate}} times per second, next to up to {{derived.maxOpponents}} other bots.

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
{{EXAMPLE_BOT}}
```
