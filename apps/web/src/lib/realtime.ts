import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

type Event = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

interface Options {
  /** Supabase table name, e.g. 'proposals'. */
  table: string;
  /** Optional filter in the form 'column=eq.value'. Multiple not supported here. */
  filter?: string;
  /** Events to listen for. Defaults to all. */
  event?: Event;
  /**
   * Optional channel-name prefix for debugging. A random suffix is
   * always appended so two hook instances with the same options can
   * coexist without Supabase rejecting the second with
   * "cannot add postgres_changes callbacks after subscribe()" -- which
   * fires when `supabase.channel(name)` returns an already-subscribed
   * channel from a previous mount whose removeChannel hasn't finished.
   */
  channel?: string;
}

/**
 * Subscribe to postgres_changes on a table and invoke `onChange` on
 * every event. RLS is applied server-side so the callback only fires
 * for rows this user can read.
 *
 * Intentionally opaque -- callers usually just want "trigger a
 * re-fetch when the database changed". The callback receives nothing
 * so consumers can't accidentally rely on the raw payload shape.
 */
export function useRealtimeRefresh(opts: Options, onChange: () => void) {
  // Keep the latest callback in a ref so the subscription doesn't
  // tear down every render.
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    // Unique per mount. React 18 strict mode, route-level remounts,
    // and fast-refresh all re-run this effect, and the new run can
    // land before Supabase's async removeChannel finishes. Giving
    // each run its own channel name makes the two lifecycles
    // independent.
    const suffix = Math.random().toString(36).slice(2, 10);
    const base = opts.channel ?? `${opts.table}:${opts.filter ?? 'all'}`;
    const name = `${base}:${suffix}`;
    const channel = supabase
      .channel(name)
      .on(
        'postgres_changes' as never,
        {
          event: opts.event ?? '*',
          schema: 'public',
          table: opts.table,
          ...(opts.filter ? { filter: opts.filter } : {}),
        } as never,
        () => cb.current(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [opts.table, opts.filter, opts.event, opts.channel]);
}
