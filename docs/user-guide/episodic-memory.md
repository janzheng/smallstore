---
title: Episodic Memory
description: Time-aware memory with importance decay for AI agents.
---

# Episodic Memory

EpisodicStore provides agent-style memory that fades over time. Memories have importance scores that decay, making recent and frequently-accessed memories easier to recall.

## Setup

```typescript
import { createSmallstore, createEpisodicStore } from '@smallstore/core';

const store = createSmallstore({ preset: 'cloud' });
const memory = createEpisodicStore(store, {
  namespace: 'agent-memory',
});
```

## Remembering

```typescript
// Store a memory with importance
await memory.remember({
  content: "User prefers dark mode and compact layouts",
  importance: 0.8,
  tags: ['preferences', 'ui'],
  context: {
    source: 'user-settings',
    timestamp: new Date(),
  },
});

await memory.remember({
  content: "User asked about Smallstore documentation",
  importance: 0.5,
  tags: ['questions', 'docs'],
  sequence: 'conversation-123',  // Group related memories
});
```

## Recalling

```typescript
// Recall by relevance
const relevant = await memory.recall({
  query: "user preferences",
  limit: 5,
});

// Recall recent memories
const recent = await memory.recall({
  timeRange: { start: new Date(Date.now() - 86400000) }, // Last 24h
  limit: 10,
});

// Recall by tags
const uiMemories = await memory.recall({
  tags: ['ui', 'preferences'],
});
```

## Importance Decay

Memories fade over time unless reinforced:

```typescript
// Manually decay old memories
const result = await memory.decay({
  halfLife: 7 * 24 * 60 * 60 * 1000, // 7 days
  threshold: 0.1,                      // Remove below 10% importance
});
console.log(`Decayed: ${result.decayed}, Removed: ${result.removed}`);
```

Decay follows an exponential curve. A memory with importance 1.0 and a 7-day half-life will be at 0.5 after a week, 0.25 after two weeks, etc.

## Reinforcement

When a memory is accessed or proven relevant, boost it:

```typescript
import { boostImportance } from '@smallstore/core';

// Boost a specific memory's importance
const boosted = boostImportance(episode, 0.3);  // +30% importance
```

## Timeline

```typescript
// Get a timeline of memories
const timeline = await memory.timeline({
  sequence: 'conversation-123',
  order: 'chronological',
});
```

## Use Cases

- **AI agent memory** — Remember user preferences, past interactions
- **Conversation context** — Track what was discussed across sessions
- **Learning systems** — Reinforce useful patterns, forget irrelevant ones
- **Activity logs** — Time-ordered events with natural decay
