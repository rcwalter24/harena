import './styles.css';
import type { MatchSetup } from './matchSetup.ts';
import { mountMatch } from './matchView.ts';
import { mountSetup } from './setup.ts';

const app = document.getElementById('app')!;
let dispose: (() => void) | null = null;

function showSetup(): void {
  dispose?.();
  dispose = mountSetup(app, showMatch);
}

function showMatch(setup: MatchSetup): void {
  dispose?.();
  dispose = mountMatch(app, setup, showSetup);
}

showSetup();
