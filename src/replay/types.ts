/**
 * A message as the replay engine sees it.
 *
 * Structural on purpose: the engine knows nothing about ably, so its tests need
 * no SDK at all and the channel adapts at the boundary. ably's `InboundMessage`
 * carries `id` and `timestamp` as required fields but leaves `name` and `data`
 * optional, so that adapter fills `name` in (`message.name ?? ""`, exactly as
 * `AblyChannel.listenToAll` already does) rather than casting.
 */
export type ReplayMessage = {
    id: string;
    name: string;
    data: unknown;
    timestamp: number;
};

/**
 * One page of history results: the slice of ably's
 * `PaginatedResult<InboundMessage>` a catch-up walk uses, with its items mapped
 * to `ReplayMessage`.
 */
export type HistoryPage = {
    items: ReplayMessage[];
    hasNext(): boolean;
    next(): Promise<HistoryPage | null>;
};

/**
 * The outcome of a catch-up. `complete: false` means the channel could not be
 * healed and the app should refetch its state — nothing is replayed in that
 * case, so `count` is 0.
 */
export type ReplayResult = { complete: boolean; count: number };

/** The `ably.replay` driver option: off by default, `limit` defaulting to 100. */
export type ReplayOptions = boolean | { limit?: number };

/** `ReplayOptions` with every default filled in. */
export type NormalizedReplay = { enabled: boolean; limit: number };

/** Everything the engine needs from the channel it is catching up. */
export type ReplayDeps = {
    /** Query ably history; params are the SDK's `RealtimeHistoryParams`. */
    history: (params: Record<string, unknown>) => Promise<HistoryPage>;
    /** Route a message to the app's listeners. */
    dispatch: (message: ReplayMessage) => void;
    /** Surface a failure the way the channel's `error()` callbacks expect. */
    onError: (error: unknown) => void;
    /** The most messages one catch-up may replay. */
    limit: number;
};
