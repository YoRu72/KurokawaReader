// The connections a file download is given: the reader's own number (Settings → Downloads, or what the speed test
// found best) over the number each place in the app asks for; the app's choice when none is set.
import { getSettings } from '../settings';
import type { AddOptions } from './types';

export function withConnections(o: AddOptions): AddOptions {
  const n = getSettings().connections;
  return n > 0 && !o.source.magnet && !o.source.torrent ? { ...o, connections: Math.max(1, Math.min(32, n)) } : o;
}
