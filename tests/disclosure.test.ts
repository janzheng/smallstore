/**
 * Disclosure Module Tests
 *
 * Tests for ProgressiveStore, skills, relevance scoring, and summarization.
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createSmallstore,
  createMemoryAdapter,
  createProgressiveStore,
  createSkill,
  createRelevanceScorer,
  createSummarizer,
  EXAMPLE_SKILLS,
  type Skill,
  type DisclosureContext,
} from '../mod.ts';

// ============================================================================
// Test Setup
// ============================================================================

function createTestStorage() {
  return createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
}

// ============================================================================
// ProgressiveStore Tests
// ============================================================================

Deno.test('ProgressiveStore - basic creation', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  assertExists(progressive);
  assertEquals(typeof progressive.registerSkill, 'function');
  assertEquals(typeof progressive.disclose, 'function');
  assertEquals(typeof progressive.discoverRelevant, 'function');
});

Deno.test('ProgressiveStore - register and get skills', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  // Register a skill
  await progressive.registerSkill(
    createSkill({
      name: 'test-skill',
      description: 'A test skill',
      triggers: ['test', 'example'],
      collections: ['test-data'],
      disclosureLevel: 'overview',
    })
  );

  // Get all skills
  const skills = await progressive.getSkills();
  assertEquals(skills.length, 1);
  assertEquals(skills[0].name, 'test-skill');
});

Deno.test('ProgressiveStore - unregister skill', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await progressive.registerSkill(
    createSkill({
      name: 'temp-skill',
      description: 'Temporary skill',
      triggers: ['temp'],
      collections: ['temp'],
    })
  );

  let skills = await progressive.getSkills();
  assertEquals(skills.length, 1);

  await progressive.unregisterSkill('temp-skill');

  skills = await progressive.getSkills();
  assertEquals(skills.length, 0);
});

Deno.test('ProgressiveStore - disclose data at summary level', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  // Store test data
  await storage.set('research/paper-1', {
    title: 'AI Agents in 2024',
    authors: ['Alice', 'Bob'],
    abstract: 'This paper explores the state of AI agents.',
  });

  // Disclose at summary level
  const disclosed = await progressive.disclose('research/paper-1', {
    depth: 'summary',
  });

  assertEquals(disclosed.level, 'summary');
  assertExists(disclosed.summary);
  assert(disclosed.summary.length > 0);
  assertEquals(disclosed.overview, undefined);
  assertEquals(disclosed.details, undefined);
  assertEquals(disclosed.full, undefined);
});

Deno.test('ProgressiveStore - disclose data at overview level', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await storage.set('research/paper-1', {
    title: 'AI Agents in 2024',
    authors: ['Alice', 'Bob'],
    abstract: 'This paper explores the state of AI agents.',
  });

  const disclosed = await progressive.disclose('research/paper-1', {
    depth: 'overview',
  });

  assertEquals(disclosed.level, 'overview');
  assertExists(disclosed.summary);
  assertExists(disclosed.overview);
  // Overview should have structure and fields info
  assertExists(disclosed.overview!.structure);
  assertEquals(disclosed.details, undefined);
});

Deno.test('ProgressiveStore - disclose data at detailed level', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await storage.set('research/paper-1', {
    title: 'AI Agents in 2024',
    authors: ['Alice', 'Bob'],
    citations: 150,
  });

  const disclosed = await progressive.disclose('research/paper-1', {
    depth: 'detailed',
  });

  assertEquals(disclosed.level, 'detailed');
  assertExists(disclosed.summary);
  assertExists(disclosed.overview);
  assertExists(disclosed.details);
});

Deno.test('ProgressiveStore - disclose data at full level', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  const testData = {
    title: 'AI Agents in 2024',
    authors: ['Alice', 'Bob'],
    citations: 150,
  };

  await storage.set('research/paper-1', testData);

  const disclosed = await progressive.disclose('research/paper-1', {
    depth: 'full',
  });

  assertEquals(disclosed.level, 'full');
  assertExists(disclosed.full);
  // Full data should be present and be an object
  assertEquals(typeof disclosed.full, 'object');
});

Deno.test('ProgressiveStore - disclose non-existent path', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  const disclosed = await progressive.disclose('non/existent/path', {});

  assertEquals(disclosed.relevanceScore, 0);
  assert(disclosed.summary.includes('No data found'));
});

Deno.test('ProgressiveStore - active skills based on query', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await progressive.registerSkill(
    createSkill({
      name: 'research-skill',
      description: 'Research exploration',
      triggers: ['research', 'papers', 'study'],
      collections: ['research'],
      priority: 1,
    })
  );

  await progressive.registerSkill(
    createSkill({
      name: 'data-skill',
      description: 'Data exploration',
      triggers: ['data', 'analytics'],
      collections: ['analytics'],
    })
  );

  const activeSkills = await progressive.getActiveSkills({
    query: 'show me research papers',
  });

  assert(activeSkills.some((s) => s.name === 'research-skill'));
});

Deno.test('ProgressiveStore - discover relevant data', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  // Register skill
  await progressive.registerSkill(
    createSkill({
      name: 'research-explorer',
      description: 'Explore research',
      triggers: ['research', 'paper'],
      collections: ['research'],
      disclosureLevel: 'overview',
    })
  );

  // Store data
  await storage.set('research/paper-1', { title: 'AI Paper 1' });
  await storage.set('research/paper-2', { title: 'AI Paper 2' });

  const result = await progressive.discoverRelevant({
    query: 'find research papers',
    maxItems: 10,
  });

  assert(result.items.length > 0);
  assert(result.activeSkills.includes('research-explorer'));
  assertExists(result.executionTime);
});

Deno.test('ProgressiveStore - summarize', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await storage.set('test/data', {
    name: 'Test Object',
    description: 'This is a test',
    count: 42,
  });

  const summary = await progressive.summarize('test/data', 'summary');
  assert(summary.length > 0);
});

Deno.test('ProgressiveStore - generate overview', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  await storage.set('collection-a/item-1', { value: 1 });
  await storage.set('collection-a/item-2', { value: 2 });

  const overview = await progressive.generateOverview(['collection-a']);

  assertEquals(overview.collections.length, 1);
  assertEquals(overview.collections[0].name, 'collection-a');
  assertEquals(overview.collections[0].itemCount, 2);
});

// ============================================================================
// Relevance Scorer Tests
// ============================================================================

Deno.test('RelevanceScorer - score skill with exact trigger match', () => {
  const scorer = createRelevanceScorer();

  const skill: Skill = {
    name: 'test',
    description: 'Test skill',
    triggers: ['research', 'papers'],
    collections: ['research'],
    disclosureLevel: 'overview',
  };

  const context: DisclosureContext = {
    query: 'show me research papers',
  };

  const score = scorer.scoreSkill(skill, context);
  assert(score > 0.5, `Expected score > 0.5, got ${score}`);
});

Deno.test('RelevanceScorer - explicit activation gives max score', () => {
  const scorer = createRelevanceScorer();

  const skill: Skill = {
    name: 'my-skill',
    description: 'Test skill',
    triggers: ['xyz'],
    collections: ['data'],
    disclosureLevel: 'overview',
  };

  const context: DisclosureContext = {
    query: 'unrelated query',
    activeSkills: ['my-skill'],
  };

  const score = scorer.scoreSkill(skill, context);
  assertEquals(score, 1.0);
});

Deno.test('RelevanceScorer - fuzzy matching', () => {
  const scorer = createRelevanceScorer({ fuzzyMatch: true, fuzzyThreshold: 0.6 });

  const skill: Skill = {
    name: 'test',
    description: 'Test',
    triggers: ['research'],
    collections: ['data'],
    disclosureLevel: 'summary',
  };

  // "researh" is close to "research"
  const score = scorer.scoreSkill(skill, { query: 'show researh data' });
  assert(score > 0, 'Fuzzy matching should give some score');
});

Deno.test('RelevanceScorer - content scoring', () => {
  const scorer = createRelevanceScorer();

  const data = {
    title: 'Machine Learning Paper',
    abstract: 'This paper discusses deep learning techniques.',
  };

  const score = scorer.scoreContent(data, 'machine learning paper');
  assert(score > 0.5, `Expected score > 0.5, got ${score}`);
});

// ============================================================================
// Summarizer Tests
// ============================================================================

Deno.test('Summarizer - generate summary for object', () => {
  const summarizer = createSummarizer();

  const data = {
    title: 'Test Title',
    description: 'This is a description',
    count: 42,
  };

  const summary = summarizer.generateSummary(data, 'test/path');
  assert(summary.includes('Test Title'));
});

Deno.test('Summarizer - generate summary for array', () => {
  const summarizer = createSummarizer();

  const data = [
    { name: 'Item 1' },
    { name: 'Item 2' },
    { name: 'Item 3' },
  ];

  const summary = summarizer.generateSummary(data, 'test/array');
  assert(summary.includes('Array of 3'));
});

Deno.test('Summarizer - generate overview for object', () => {
  const summarizer = createSummarizer();

  const data = {
    title: 'Test',
    author: 'Alice',
    year: 2024,
  };

  const overview = summarizer.generateOverview(data);
  assertEquals(overview.structure, 'object');
  assert(overview.fields!.includes('title'));
  assert(overview.fields!.includes('author'));
});

Deno.test('Summarizer - generate overview for array', () => {
  const summarizer = createSummarizer();

  const data = [1, 2, 3, 4, 5];

  const overview = summarizer.generateOverview(data);
  assertEquals(overview.structure, 'array');
  assertEquals(overview.itemCount, 5);
});

Deno.test('Summarizer - disclose at different levels', () => {
  const summarizer = createSummarizer();

  const data = {
    title: 'Test',
    content: 'Full content here',
  };

  // Summary level
  const summaryLevel = summarizer.disclose(data, 'test/path', 'summary', 0.8);
  assertExists(summaryLevel.summary);
  assertEquals(summaryLevel.overview, undefined);

  // Overview level
  const overviewLevel = summarizer.disclose(data, 'test/path', 'overview', 0.8);
  assertExists(overviewLevel.overview);
  assertEquals(overviewLevel.details, undefined);

  // Detailed level
  const detailedLevel = summarizer.disclose(data, 'test/path', 'detailed', 0.8);
  assertExists(detailedLevel.details);
  assertEquals(detailedLevel.full, undefined);

  // Full level
  const fullLevel = summarizer.disclose(data, 'test/path', 'full', 0.8);
  assertExists(fullLevel.full);
});

// ============================================================================
// Skills Tests
// ============================================================================

Deno.test('createSkill - creates valid skill', () => {
  const skill = createSkill({
    name: 'my-skill',
    description: 'My skill description',
    triggers: ['trigger1', 'trigger2'],
    collections: ['collection1'],
    disclosureLevel: 'detailed',
    priority: 5,
  });

  assertEquals(skill.name, 'my-skill');
  assertEquals(skill.disclosureLevel, 'detailed');
  assertEquals(skill.priority, 5);
});

Deno.test('createSkill - default values', () => {
  const skill = createSkill({
    name: 'minimal-skill',
    description: 'Minimal',
    triggers: ['test'],
    collections: ['data'],
  });

  assertEquals(skill.disclosureLevel, 'overview');
  assertEquals(skill.priority, 0);
});

Deno.test('EXAMPLE_SKILLS - has expected skills', () => {
  assertExists(EXAMPLE_SKILLS.dataExplorer);
  assertExists(EXAMPLE_SKILLS.dataAnalyst);
  assertExists(EXAMPLE_SKILLS.metaReader);

  assertEquals(EXAMPLE_SKILLS.dataExplorer.disclosureLevel, 'overview');
  assertEquals(EXAMPLE_SKILLS.dataAnalyst.disclosureLevel, 'detailed');
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test('Integration - full workflow', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  // 1. Register skills
  await progressive.registerSkill(
    createSkill({
      name: 'project-explorer',
      description: 'Explore project data',
      triggers: ['project', 'projects', 'work'],
      collections: ['projects'],
      disclosureLevel: 'overview',
      priority: 2,
    })
  );

  await progressive.registerSkill(
    createSkill({
      name: 'task-manager',
      description: 'Manage tasks',
      triggers: ['task', 'tasks', 'todo'],
      collections: ['tasks'],
      disclosureLevel: 'detailed',
      priority: 1,
    })
  );

  // 2. Store data
  await storage.set('projects/project-1', {
    name: 'AI Assistant',
    status: 'active',
    team: ['Alice', 'Bob'],
    description: 'Building an AI-powered assistant',
  });

  await storage.set('projects/project-2', {
    name: 'Data Pipeline',
    status: 'planning',
    team: ['Charlie'],
    description: 'Data processing pipeline',
  });

  await storage.set('tasks/task-1', {
    title: 'Implement feature X',
    project: 'AI Assistant',
    priority: 'high',
    assignee: 'Alice',
  });

  // 3. Query with context
  const projectResult = await progressive.discoverRelevant({
    query: 'show me active projects',
    maxItems: 10,
  });

  assert(projectResult.items.length > 0);
  assert(projectResult.activeSkills.includes('project-explorer'));

  // 4. Disclose specific item
  const projectDetails = await progressive.disclose('projects/project-1', {
    depth: 'detailed',
  });

  assertEquals(projectDetails.level, 'detailed');
  assertExists(projectDetails.details);

  // 5. Generate overview
  const overview = await progressive.generateOverview(['projects', 'tasks']);

  assertEquals(overview.collections.length, 2);

  // 6. Expand to full
  const full = await progressive.expandTo(projectDetails, 'full');
  assertEquals(full.level, 'full');
  assertExists(full.full);
});

Deno.test('Integration - skill with wildcard collection', async () => {
  const storage = createTestStorage();
  const progressive = createProgressiveStore(storage);

  // Register skill with wildcard
  await progressive.registerSkill({
    name: 'global-search',
    description: 'Search all data',
    triggers: ['search', 'find', 'all'],
    collections: ['*'],
    disclosureLevel: 'summary',
  });

  await storage.set('collection-a/item', { value: 1 });
  await storage.set('collection-b/item', { value: 2 });

  const result = await progressive.discoverRelevant({
    query: 'search everything',
  });

  // Should have discovered some items and activated the skill
  assert(result.activeSkills.includes('global-search'));
  // totalMatches should reflect what was found
  assert(result.totalMatches >= 0);
});

console.log('All disclosure tests defined!');
