/**
 * Messaging plugin family
 *
 * Channel + Inbox primitives. Outbox sketched in types only (v2).
 *
 * See `.brief/messaging-plugins.md` for the design.
 */

export type {
  Attachment,
  BlobPayload,
  Channel,
  ChannelKind,
  IngestOptions,
  Inbox,
  InboxConfig,
  InboxFilter,
  InboxItem,
  InboxItemFull,
  InboxStorage,
  InboxStorageSpec,
  ListOptions,
  ListResult,
  Outbox,
  OutboxDraft,
  OutboxStatus,
  ParseResult,
  PullResult,
  QueryOptions,
  ReadOptions,
  Sink,
  SinkContext,
  SinkResult,
} from './types.ts';

export { decodeCursor, encodeCursor, type Cursor } from './cursor.ts';
export { evaluateFilter } from './filter.ts';
export { Inbox as ReferenceInbox, createInbox } from './inbox.ts';
export { parseFilterSpec, type FilterSpec } from './filter-spec.ts';
export {
  InboxRegistry,
  type InboxRegistration,
  type RegisterSinksOptions,
  registerChannel,
  getChannel,
  listChannels,
} from './registry.ts';
export { inboxSink, httpSink, functionSink, type HttpSinkOptions } from './sinks.ts';
export { registerMessagingRoutes, type RegisterMessagingRoutesOptions, type RequireAuth } from './http-routes.ts';
export { CloudflareEmailChannel, cloudflareEmailChannel, type EmailInput } from './channels/cf-email.ts';
export { createEmailHandler, type CreateEmailHandlerOptions, type ForwardableEmailMessage } from './email-handler.ts';
