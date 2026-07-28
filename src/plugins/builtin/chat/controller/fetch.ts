import {
  apiClient,
  type ChatMessage,
} from "../../../../api-client";
import {
  MESSAGE_PAGE_SIZE,
  type ChannelRuntimeState,
  type MergeMessagesOptions,
} from "./state";
import { isLegacyTimestampCursor } from "./utils";

interface ChatFetchDeps {
  mergeMessages(channelId: string, messages: ChatMessage[], options?: MergeMessagesOptions): void;
  persistChannelState(channelId: string): void;
}

export async function fetchLatestChannelMessages(
  channelId: string,
  channel: ChannelRuntimeState,
  deps: ChatFetchDeps,
): Promise<void> {
  const legacyTimestampCursor = isLegacyTimestampCursor(channel.lastCursor);
  const hasIncrementalCursor = !!channel.lastCursor;
  const hadMessages = channel.messages.length > 0;
  const countIncrementalUnread = hadMessages && hasIncrementalCursor && !legacyTimestampCursor;
  // The first fetch of a session drops the cursor so anything missed while the
  // socket was connected comes back. Merging is keyed by message id, so
  // re-reading known messages changes nothing and counts no unread.
  const backfillGaps = !channel.backfilled;

  try {
    const messages = await apiClient.getMessages(channelId, {
      limit: MESSAGE_PAGE_SIZE,
      after: backfillGaps ? undefined : channel.lastCursor ?? undefined,
    });
    channel.backfilled = true;
    if ((!hasIncrementalCursor || backfillGaps) && messages.length < MESSAGE_PAGE_SIZE) {
      channel.reachedOldestMessage = true;
    }
    if (messages.length > 0) {
      deps.mergeMessages(channelId, messages, { countUnread: countIncrementalUnread });
      return;
    }
    if (legacyTimestampCursor) {
      const fullRefresh = await apiClient.getMessages(channelId, { limit: MESSAGE_PAGE_SIZE });
      if (fullRefresh.length < MESSAGE_PAGE_SIZE) {
        channel.reachedOldestMessage = true;
      }
      if (fullRefresh.length > 0) {
        deps.mergeMessages(channelId, fullRefresh, { countUnread: false });
        return;
      }
      channel.lastCursor = null;
    }
    deps.persistChannelState(channelId);
    return;
  } catch {
    const messages = await apiClient.getMessages(channelId, { limit: MESSAGE_PAGE_SIZE });
    channel.backfilled = true;
    if (messages.length < MESSAGE_PAGE_SIZE) {
      channel.reachedOldestMessage = true;
    }
    if (messages.length > 0) {
      deps.mergeMessages(channelId, messages, { countUnread: false });
      return;
    }
    deps.persistChannelState(channelId);
  }
}

export async function fetchOlderChannelMessages(
  channelId: string,
  before: string,
  channel: ChannelRuntimeState,
  deps: ChatFetchDeps,
): Promise<void> {
  const messages = await apiClient.getMessages(channelId, {
    limit: MESSAGE_PAGE_SIZE,
    before,
  });
  if (messages.length < MESSAGE_PAGE_SIZE) {
    channel.reachedOldestMessage = true;
  }
  if (messages.length === 0) {
    deps.persistChannelState(channelId);
    return;
  }
  deps.mergeMessages(channelId, messages, { countUnread: false });
}
