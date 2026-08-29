'use strict';

/**
 * BullMQ optional queue driver tests — NFR-6, design §6 "Optional Redis path"
 * (Task 15, optional stretch).
 *
 * These tests prove the BullMQ adapter honors the SAME service contract as the
 * DB driver and behaves gracefully when the optional dependency is absent:
 *   - `enqueueJob` persists the job + items (same as db) AND pushes a BullMQ job
 *     (Queue.add) — proving the same contract;
 *   - the driver selector returns the bullmq adapter for QUEUE_DRIVER=bullmq and
 *     the db service otherwise (lazy selection, no bullmq load on the db path);
 *   - `startWorker` wires a BullMQ Worker whose processor drives the SAME
 *     `handleItem` logic (contract parity);
 *   - a clear, actionable error is thrown when bullmq is missing or REDIS_URL is
 *     unset (graceful degradation).
 *
 * `bullmq` is mocked with jest.mock so no Redis is required to run these.
 */

process.env.NODE_ENV = 'test';

// --- Mock bullmq: Queue.add and Worker constructor are jest fns we assert on.
// Names are `mock`-prefixed so jest.mock's factory may reference them (jest
// hoists the factory above these declarations but allows mock-prefixed vars).
const mockAdd = jest.fn(async () => ({ id: 'bull-1' }));
const mockQueueCtor = jest.fn(function Queue(name, opts) {
  this.name = name;
  this.opts = opts;
  this.add = mockAdd;
});
const mockWorkerOn = jest.fn();
const mockWorkerCtor = jest.fn(function Worker(name, processor, opts) {
  this.name = name;
  this.processor = processor;
  this.opts = opts;
  this.on = mockWorkerOn;
});

jest.mock('bullmq', () => ({ Queue: mockQueueCtor, Worker: mockWorkerCtor }), { virtual: true });

const bullmqDriver = require('../src/services/queueDriverBullmq');
const { getDriver } = require('../src/services/queueDriver');
const dbQueueService = require('../src/services/queueService');

const CFG_BULLMQ = { queue: { driver: 'bullmq', redisUrl: 'redis://127.0.0.1:6379' }, worker: { batch: 5 } };

beforeEach(() => {
  jest.clearAllMocks();
  bullmqDriver._reset();
});

describe('queueDriver selection (design §6, NFR-6)', () => {
  test('QUEUE_DRIVER=db returns the DB queue service (bullmq not loaded)', () => {
    const driver = getDriver({ queue: { driver: 'db' } });
    expect(driver.name).toBe('db');
    expect(driver.enqueueJob).toBe(dbQueueService.enqueueJob);
    expect(driver.enqueueRetry).toBeUndefined();
  });

  test('QUEUE_DRIVER=bullmq returns the bullmq adapter with the same contract', () => {
    const driver = getDriver({ queue: { driver: 'bullmq' } });
    expect(driver.name).toBe('bullmq');
    expect(typeof driver.enqueueJob).toBe('function');
    expect(typeof driver.enqueueRetry).toBe('function');
  });
});

describe('bullmq enqueueJob — same contract as the DB driver', () => {
  test('persists job + items AND enqueues a BullMQ job (Queue.add)', async () => {
    const bulkJob = { create: jest.fn(async () => 42) };
    const bulkJobItem = { insertMany: jest.fn(async () => 2) };

    const rows = [
      { toE164: '+12025550182', rawInput: 'a', variables: null, valid: true },
      { toE164: '+442071838750', rawInput: 'b', variables: null, valid: true },
      { toE164: null, rawInput: 'bad', variables: null, valid: false, reason: 'invalid' },
    ];

    const result = await bullmqDriver.enqueueJob(
      { name: 'promo', templateName: 'promo_v1', language: 'en_US' },
      rows,
      { config: CFG_BULLMQ, bulkJob, bulkJobItem }
    );

    // Same return shape as queueService.enqueueJob.
    expect(result).toEqual({ jobId: 42, status: 'running', total: 3, pending: 2, skipped: 1 });

    // Persisted the job with correct counters (contract parity).
    expect(bulkJob.create).toHaveBeenCalledTimes(1);
    expect(bulkJob.create.mock.calls[0][0]).toMatchObject({
      templateName: 'promo_v1',
      language: 'en_US',
      status: 'running',
      totalCount: 3,
      skippedCount: 1,
    });

    // Persisted items: 2 pending + 1 skipped_invalid.
    const items = bulkJobItem.insertMany.mock.calls[0][1];
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.status === 'pending')).toHaveLength(2);
    expect(items.filter((i) => i.status === 'skipped_invalid')).toHaveLength(1);

    // Pushed a BullMQ job to drain the work (proving the queue is used).
    expect(mockQueueCtor).toHaveBeenCalledWith('bulk-send-items', expect.objectContaining({
      connection: { url: 'redis://127.0.0.1:6379' },
    }));
    expect(mockAdd).toHaveBeenCalledWith('drain-job', { jobId: 42 }, expect.any(Object));
  });

  test('all-invalid job → completed, nothing enqueued on the queue', async () => {
    const bulkJob = { create: jest.fn(async () => 43) };
    const bulkJobItem = { insertMany: jest.fn(async () => 1) };

    const result = await bullmqDriver.enqueueJob(
      { templateName: 't', language: 'en' },
      [{ toE164: null, rawInput: 'bad', valid: false, reason: 'x' }],
      { config: CFG_BULLMQ, bulkJob, bulkJobItem }
    );

    expect(result).toMatchObject({ status: 'completed', pending: 0, skipped: 1 });
    // No pending work → no queue push.
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('bullmq startWorker — drives the same handleItem logic', () => {
  test('creates a BullMQ Worker; its processor claims + handles items then completes the job', async () => {
    const jobRow = { id: 7, template_name: 'promo', language: 'en_US', msg_type: 'template' };
    const claimed = [{ id: 1, job_id: 7, to_e164: '+1', raw_input: 'x', variables: null }];

    const bulkJob = {
      getById: jest.fn(async () => jobRow),
      updateStatus: jest.fn(async () => true),
    };
    const bulkJobItem = {
      claimPending: jest.fn(async () => claimed),
      countOutstanding: jest.fn(async () => 0),
    };
    const handleItem = jest.fn(async () => 'sent');
    const fakeWorker = { handleItem };

    const bullWorker = bullmqDriver.startWorker({
      config: CFG_BULLMQ,
      bulkJob,
      bulkJobItem,
      worker: fakeWorker,
      logger: { info: () => {}, error: () => {} },
    });

    // A BullMQ Worker was constructed against the right queue + connection.
    expect(mockWorkerCtor).toHaveBeenCalledTimes(1);
    expect(mockWorkerCtor.mock.calls[0][0]).toBe('bulk-send-items');
    expect(mockWorkerCtor.mock.calls[0][2]).toMatchObject({ connection: { url: 'redis://127.0.0.1:6379' } });

    // Run the processor as BullMQ would, with a drain-job payload.
    const processor = mockWorkerCtor.mock.calls[0][1];
    await processor({ data: { jobId: 7 } });

    // It reused the SAME handleItem contract and completed the job.
    expect(bulkJobItem.claimPending).toHaveBeenCalled();
    expect(handleItem).toHaveBeenCalledWith(claimed[0], jobRow);
    expect(bulkJob.updateStatus).toHaveBeenCalledWith(7, 'completed');

    expect(bullWorker).toBeDefined();
  });
});

describe('graceful degradation (NFR-6)', () => {
  test('resolveConnection throws a clear error when REDIS_URL is missing', () => {
    expect(() => bullmqDriver.resolveConnection({ queue: { driver: 'bullmq', redisUrl: '' } }))
      .toThrow(/REDIS_URL/);
    try {
      bullmqDriver.resolveConnection({ queue: {} });
    } catch (e) {
      expect(e.code).toBe('REDIS_URL_MISSING');
    }
  });

  test('loadBullmq throws an actionable BULLMQ_NOT_INSTALLED error when require fails', () => {
    // Simulate the package being absent by making require throw via jest.isolateModules
    // + a mock that is not present. We test the error wrapper directly by monkeypatching.
    jest.resetModules();
    jest.doMock('bullmq', () => {
      throw new Error("Cannot find module 'bullmq'");
    }, { virtual: true });

    // eslint-disable-next-line global-require
    const freshDriver = require('../src/services/queueDriverBullmq');
    expect(() => freshDriver.loadBullmq()).toThrow(/requires the optional 'bullmq' package/);
    try {
      freshDriver.loadBullmq();
    } catch (e) {
      expect(e.code).toBe('BULLMQ_NOT_INSTALLED');
    }

    jest.dontMock('bullmq');
  });
});
