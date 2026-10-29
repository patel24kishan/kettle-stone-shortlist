// The Anthropic client for the import, built the way the CLI builds it (scripts/shortlist.ts): only when
// ANTHROPIC_API_KEY is set. Next.js loads .env.local itself. SHORTLIST_NO_CLAUDE=1 forces no client (tests).
// Server only: never import this from a client component.
import Anthropic from '@anthropic-ai/sdk';

export function claudeConfigured(): boolean {
  if (process.env.SHORTLIST_NO_CLAUDE === '1') return false;
  return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== '';
}

export function defaultClaudeClient(): Anthropic | null {
  if (!claudeConfigured()) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });
}
