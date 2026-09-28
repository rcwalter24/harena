import './styles.css';
import type { Replay } from '../engine/replay.ts';
import { applyLang } from './i18n.ts';
import type { MatchSetup } from './matchSetup.ts';
import { mountMatch } from './matchView.ts';
import { mountReplay } from './replayView.ts';
import { mountSetup } from './setup.ts';

applyLang();
const app = document.getElementById('app')!;
let dispose: (() => void) | null = null;

function show(mount: () => () => void): void {
  dispose?.();
  dispose = null;
  dispose = mount();
}

function showSetup(): void {
  show(() => mountSetup(app, { onStart: showMatch, onReplay: showReplay, onLanguage: showSetup }));
}

function showMatch(setup: MatchSetup): void {
  show(() => mountMatch(app, setup, { onExit: showSetup, onReplay: showReplay }));
}

function showReplay(replay: Replay): void {
  show(() => mountReplay(app, replay, { onExit: showSetup }));
}

showSetup();
