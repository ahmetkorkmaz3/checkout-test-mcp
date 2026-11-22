import type { ResponseMatch, StatusMatch, TextMatch } from '../schemas/scenario.js';

/** URL glob: "**" matches anything, "*" matches inside one path segment. Matches the full URL. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/?#]*';
      }
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function urlMatchesGlob(url: string, glob: string): boolean {
  return globToRegExp(glob).test(url);
}

export function statusMatches(status: number, match: StatusMatch | undefined): boolean {
  if (match === undefined) return true;
  if (typeof match === 'number') return status === match;
  return Math.floor(status / 100) === Number(match[0]);
}

export interface RecordedResponse {
  method: string;
  url: string;
  status: number;
  stepIndex: number;
}

export function responseMatches(r: RecordedResponse, m: ResponseMatch, checkStatus = true): boolean {
  if (m.method && m.method.toUpperCase() !== r.method.toUpperCase()) return false;
  if (!urlMatchesGlob(r.url, m.url)) return false;
  return checkStatus ? statusMatches(r.status, m.status) : true;
}

export function toTextMatcher(m: TextMatch): string | RegExp {
  return typeof m === 'string' ? m : new RegExp(m.matches, 'i');
}

export function describeTextMatch(m: TextMatch): string {
  return typeof m === 'string' ? `"${m}"` : `/${m.matches}/i`;
}

export function describeResponseMatch(m: ResponseMatch): string {
  return `${m.method ?? 'ANY'} ${m.url}${m.status !== undefined ? ` -> ${m.status}` : ''}`;
}
