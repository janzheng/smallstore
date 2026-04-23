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
  HookContext,
  HookVerdict,
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
  PostClassifyHook,
  PostStoreHook,
  PreIngestHook,
  PullResult,
  QueryOptions,
  ReadOptions,
  RegistrationHooks,
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
  type HookStage,
  type InboxRegistration,
  type RegisterSinksOptions,
  registerChannel,
  getChannel,
  listChannels,
} from './registry.ts';
export { classify, classifyAndMerge } from './classifier.ts';
export { inboxSink, httpSink, functionSink, type HttpSinkOptions } from './sinks.ts';
export { registerMessagingRoutes, type RegisterMessagingRoutesOptions, type RequireAuth } from './http-routes.ts';
export { CloudflareEmailChannel, cloudflareEmailChannel, type EmailInput } from './channels/cf-email.ts';
export { createEmailHandler, type CreateEmailHandlerOptions, type ForwardableEmailMessage } from './email-handler.ts';
export {
  createSenderIndex,
  parseListUnsubscribe,
  type SenderIndex,
  type SenderIndexOptions,
  type SenderQueryFilter,
  type SenderQueryResult,
  type SenderRecord,
} from './sender-index.ts';
export {
  addSenderTag,
  unsubscribeSender,
  type UnsubscribeOptions,
  type UnsubscribeResult,
} from './unsubscribe.ts';
export {
  DEFAULT_QUARANTINE_LABEL,
  listQuarantined,
  quarantineItem,
  quarantineSink,
  restoreItem,
  type QuarantineOptions,
} from './quarantine.ts';
