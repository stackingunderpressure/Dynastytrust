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
  /** Unique channel name; defaults to `<table>:<filter ?? 'all'>`. */
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
    const name = opts.channel ?? `${opts.table}:${opts.filter ?? 'all'}`;
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
